import { sql } from "kysely";
import { Repos } from "../../repositories/Repos.js";
import { PROFILE_FIELDS } from "../../repositories/CrmRepo.js";
import { getDb } from "../../db/index.js";
import { CrmPeople, normEmail } from "./CrmPeople.js";
import { CrmAiService, Extraction } from "./CrmAiService.js";
import { countryName } from "./CrmSyncService.js";

/**
 * The CRM's person-level operations: the profile view, profile edits, quick capture (preview, then
 * save to an existing or a new person), facts, tags and notes.
 *
 * Capture never overwrites: it fills empty fields only. A value that differs from what the record
 * already holds is kept as a fact ("Also gave the number ...") for staff to judge.
 */

const digits = (s: any) => String(s || "").replace(/\D/g, "");
const clip = (s: any, n: number) => (s === null || s === undefined ? null : String(s).trim().slice(0, n) || null);
const VALID_TZ = (tz: string) => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
};

export interface Actor { userId: string; name: string }

export class CrmService {
  constructor(private repos: Repos) {}

  async profileView(churchId: string, personId: string) {
    const person: any = await (getDb() as any).selectFrom("people")
      .select(["id", "displayName", "firstName", "lastName", "email", "mobilePhone", "homePhone", "membershipStatus", "campusId", "mbidSub", "source", "dateAdded", "removed"])
      .where("churchId", "=", churchId).where("id", "=", personId).executeTakeFirst();
    if (!person) return null;
    const [profile, tags, facts, notes, activities] = await Promise.all([
      this.repos.crm.loadProfile(churchId, personId),
      this.repos.crm.loadPersonTags(churchId, personId),
      this.repos.crm.loadFacts(churchId, personId),
      this.repos.crm.loadNotes(churchId, personId),
      this.repos.crm.loadActivities(churchId, personId)
    ]);
    return {
      person: { ...person, removed: undefined, hasMbid: !!person.mbidSub, mbidSub: undefined },
      profile: profile || { contactConsent: "unknown" },
      tags,
      facts,
      notes: notes.map((n: any) => ({ ...n, images: undefined, imageCount: n.images ? JSON.parse(n.images).length : 0, extracted: undefined })),
      activities
    };
  }

  async updateProfile(churchId: string, personId: string, body: any, actor: Actor) {
    const patch: Record<string, any> = {};
    for (const f of PROFILE_FIELDS) if (f in (body || {})) patch[f] = clip(body[f], f === "countryCode" ? 2 : f === "organization" ? 150 : 120);
    if (patch.countryCode !== undefined) {
      patch.countryCode = patch.countryCode && /^[A-Za-z]{2}$/.test(patch.countryCode) ? patch.countryCode.toUpperCase() : null;
      if (patch.countryCode && !body.country) patch.country = countryName(patch.countryCode);
    }
    if (patch.timezone && !VALID_TZ(patch.timezone)) throw Object.assign(new Error("bad_timezone"), { status: 400 });
    if (body && ["yes", "no", "unknown"].includes(body.contactConsent)) {
      patch.contactConsent = body.contactConsent;
      patch.consentSource = "staff: " + actor.name.slice(0, 70);
      patch.consentAt = new Date();
    }
    await this.repos.crm.upsertProfile(churchId, personId, patch);
    return this.repos.crm.loadProfile(churchId, personId);
  }

  /** People who might be the subject of a capture: same email, same phone (last 9 digits), or same name. */
  async candidatesFor(churchId: string, ex: Extraction): Promise<any[]> {
    const ids = new Set<string>();
    for (const p of await CrmPeople.findByEmails(churchId, ex.person.emails)) ids.add(p.id);
    const phones = ex.person.phones.map(digits).filter((d) => d.length >= 7).map((d) => d.slice(-9));
    if (phones.length) {
      const rows = await sql<any>`SELECT id FROM people WHERE churchId = ${churchId} AND (removed = 0 OR removed IS NULL)
        AND (RIGHT(REGEXP_REPLACE(COALESCE(mobilePhone,''), '[^0-9]', ''), 9) IN (${sql.join(phones)})
          OR RIGHT(REGEXP_REPLACE(COALESCE(homePhone,''), '[^0-9]', ''), 9) IN (${sql.join(phones)})) LIMIT 10`.execute(getDb());
      rows.rows.forEach((r: any) => ids.add(r.id));
    }
    if (ex.person.firstName && ex.person.lastName) {
      const rows = await sql<any>`SELECT id FROM people WHERE churchId = ${churchId} AND (removed = 0 OR removed IS NULL)
        AND firstName = ${ex.person.firstName} AND lastName = ${ex.person.lastName} LIMIT 10`.execute(getDb());
      rows.rows.forEach((r: any) => ids.add(r.id));
    }
    if (!ids.size) return [];
    const people = await (getDb() as any).selectFrom("people as p").leftJoin("crmProfiles as c", (j: any) => j.onRef("c.personId", "=", "p.id"))
      .select(["p.id", "p.displayName", "p.email", "p.mobilePhone", "p.membershipStatus", "c.country", "c.city"])
      .where("p.churchId", "=", churchId).where("p.id", "in", [...ids]).limit(10).execute();
    return people;
  }

  async preview(churchId: string, input: { text?: string; images?: any[]; personId?: string | null }) {
    let knownName: string | null = null;
    if (input.personId) {
      const p: any = await this.repos.person.load(churchId, input.personId);
      if (!p) throw Object.assign(new Error("not_found"), { status: 404 });
      knownName = p.displayName || [p.firstName, p.lastName].filter(Boolean).join(" ");
    }
    const extraction = await new CrmAiService(this.repos).extract({ text: input.text, images: input.images, knownName });
    const candidates = input.personId ? [] : await this.candidatesFor(churchId, extraction);
    return { extraction, candidates };
  }

  /** Save a reviewed capture: to `personId`, or to a new contact when personId is null. */
  async save(churchId: string, input: { personId?: string | null; text?: string; extraction: Extraction; imageCount?: number }, actor: Actor) {
    const ex = input.extraction;
    let personId = input.personId || null;
    let created = false;
    if (!personId) {
      if (!ex?.person?.firstName && !ex?.person?.emails?.length && !ex?.person?.phones?.length) throw Object.assign(new Error("no_identity"), { status: 400 });
      const made = await CrmPeople.ensure(this.repos, {
        churchId, emails: ex.person.emails, firstName: ex.person.firstName, lastName: ex.person.lastName, phone: ex.person.phones[0] || null, source: "capture"
      });
      personId = made.personId;
      created = made.created;
    }
    const person: any = await (getDb() as any).selectFrom("people").selectAll().where("churchId", "=", churchId).where("id", "=", personId).executeTakeFirst();
    if (!person) throw Object.assign(new Error("not_found"), { status: 404 });

    const changes: string[] = [];
    const extraFacts: string[] = [];
    const peopleSet: Record<string, any> = {};
    if (ex.person.firstName && !person.firstName) { peopleSet.firstName = clip(ex.person.firstName, 50); changes.push("first name"); }
    if (ex.person.lastName && !person.lastName) { peopleSet.lastName = clip(ex.person.lastName, 50); changes.push("last name"); }
    const emails = ex.person.emails.map(normEmail).filter(Boolean);
    if (emails.length && !person.email) { peopleSet.email = emails[0].slice(0, 100); changes.push("email"); }
    for (const e of emails) if (normEmail(person.email) !== e && peopleSet.email !== e) extraFacts.push("Also uses the email " + e);
    const phones = ex.person.phones.filter((p) => digits(p).length >= 7);
    if (phones.length && !person.mobilePhone) { peopleSet.mobilePhone = phones[0].slice(0, 21); changes.push("phone"); }
    for (const ph of phones) {
      const d = digits(ph).slice(-9);
      if (d !== digits(person.mobilePhone).slice(-9) && d !== digits(person.homePhone).slice(-9) && ph !== peopleSet.mobilePhone) extraFacts.push("Also gave the number " + ph);
    }
    if (Object.keys(peopleSet).length) {
      if (peopleSet.firstName || peopleSet.lastName) peopleSet.displayName = [peopleSet.firstName || person.firstName, peopleSet.lastName || person.lastName].filter(Boolean).join(" ").slice(0, 100);
      await (getDb() as any).updateTable("people").set(peopleSet).where("churchId", "=", churchId).where("id", "=", personId).execute();
    }

    const prof = await this.repos.crm.loadProfile(churchId, personId!);
    const patch: Record<string, any> = {};
    const fill = (key: string, val: string | null, label: string) => {
      if (!val) return;
      const cur = (prof as any)?.[key];
      if (!cur) { patch[key] = val; changes.push(label); }
      else if (String(cur).toLowerCase() !== val.toLowerCase()) extraFacts.push(`${label[0].toUpperCase() + label.slice(1)} given as ${val} (record says ${cur})`);
    };
    if (ex.person.countryCode) {
      if (!prof?.countryCode) { patch.countryCode = ex.person.countryCode; patch.country = countryName(ex.person.countryCode); changes.push("country"); }
      else if (prof.countryCode !== ex.person.countryCode) extraFacts.push(`Country given as ${countryName(ex.person.countryCode)} (record says ${prof.country || prof.countryCode})`);
    }
    fill("city", clip(ex.person.city, 80), "city");
    fill("region", clip(ex.person.region, 80), "region");
    if (ex.person.timezone && VALID_TZ(ex.person.timezone)) fill("timezone", ex.person.timezone, "time zone");
    fill("ministryRole", clip(ex.person.ministryRole, 120), "ministry role");
    fill("organization", clip(ex.person.organization, 150), "organization");
    if (ex.person.languages.length) {
      const have = (prof?.languages || "").split(",").map((s) => s.trim()).filter(Boolean);
      const merged = [...have];
      for (const l of ex.person.languages) if (!merged.some((h) => h.toLowerCase() === l.trim().toLowerCase())) merged.push(l.trim());
      if (merged.length !== have.length) { patch.languages = merged.join(", ").slice(0, 255); changes.push("languages"); }
    }
    if (ex.person.contactConsent !== "unknown" && prof?.contactConsent !== ex.person.contactConsent) {
      patch.contactConsent = ex.person.contactConsent;
      patch.consentSource = "conversation (" + actor.name.slice(0, 60) + ")";
      patch.consentAt = new Date();
      changes.push("contact consent");
    }
    await this.repos.crm.upsertProfile(churchId, personId!, patch);

    // The AI's transcript is kept only for screenshots; pasted text is already saved as written.
    const transcript = input.imageCount && ex.transcript ? "Screenshot transcript:\n" + ex.transcript.trim() : null;
    const body = [input.text?.trim(), transcript].filter(Boolean).join("\n\n") || ex.noteSummary;
    const noteId = await this.repos.crm.addNote(churchId, personId!, {
      kind: "capture", body, extracted: { summary: ex.noteSummary, changes }, addedBy: actor.userId, addedByName: actor.name,
      images: input.imageCount ? Array.from({ length: Math.min(input.imageCount, 6) }, (_, i) => "screenshot-" + (i + 1)) : []
    });
    for (const f of ex.facts) await this.repos.crm.addFact(churchId, personId!, f.kind, f.text, noteId);
    for (const t of extraFacts) await this.repos.crm.addFact(churchId, personId!, "fact", t, noteId);
    for (const tag of ex.tags.slice(0, 4)) if (tag.trim()) await this.repos.crm.tagPerson(churchId, personId!, await this.repos.crm.ensureTag(churchId, tag));
    return { personId, created, changes, facts: ex.facts.length + extraFacts.length };
  }

  async addNote(churchId: string, personId: string, text: string, actor: Actor) {
    const body = String(text || "").trim().slice(0, 20000);
    if (!body) throw Object.assign(new Error("empty"), { status: 400 });
    return this.repos.crm.addNote(churchId, personId, { kind: "note", body, addedBy: actor.userId, addedByName: actor.name });
  }

  async addFact(churchId: string, personId: string, kind: string, text: string) {
    if (!["prayer", "need", "interest", "fact", "followup"].includes(kind)) throw Object.assign(new Error("bad_kind"), { status: 400 });
    const t = String(text || "").trim();
    if (!t) throw Object.assign(new Error("empty"), { status: 400 });
    return this.repos.crm.addFact(churchId, personId, kind, t, null);
  }
}
