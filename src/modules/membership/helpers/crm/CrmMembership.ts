import { Repos } from "../../repositories/Repos.js";
import { getDb } from "../../db/index.js";
import { CrmConfig } from "./CrmConfig.js";
import { CrmPeople, normEmail } from "./CrmPeople.js";
import { CrmSyncService, countryName } from "./CrmSyncService.js";

/**
 * Joining the Global Church (the "right hand of fellowship" online). The Global Church site calls
 * this after a signed-in person reads What We Believe and accepts. Membership is immediate
 * (decision 2026-10-08): the person becomes a Member of the Online Church center, the CRM records
 * when and which statement they accepted, and staff are told by the Global Church site.
 *
 * Status only ever moves up: Contact / Visitor / Guest / Regular Attendee / Inactive / none become
 * Member; a Member or Staff record keeps its status and its own worship center.
 */

const UPGRADE = new Set(["", "contact", "visitor", "guest", "regular attendee", "inactive"]);

export interface JoinInput { sub: string; email: string; firstName?: string | null; lastName?: string | null; lang?: string | null; countryCode?: string | null; phone?: string | null; beliefsVersion?: string | null }

export class CrmMembership {
  static async onlineCampusId(repos: Repos, churchId: string): Promise<string | null> {
    const slug = process.env.CRM_ONLINE_CAMPUS_SLUG || "online-church";
    const hit = await repos.campus.loadBySlug(churchId, slug).catch(() => null);
    return hit?.campus?.id || null;
  }

  static async join(repos: Repos, input: JoinInput): Promise<{ personId: string; status: string; campusId: string | null; upgraded: boolean }> {
    const churchId = await CrmConfig.churchId(repos);
    if (!churchId) throw Object.assign(new Error("no_church"), { status: 503 });
    const email = normEmail(input.email);
    if (!input.sub || !email) throw Object.assign(new Error("bad_request"), { status: 400 });

    // The person for this Mary Banks ID (synced from Keycloak first so verified extra emails match).
    let personId = await new CrmSyncService(repos).syncOne(input.sub).catch(() => null);
    if (!personId) {
      personId = (await CrmPeople.ensure(repos, { churchId, sub: input.sub, emails: [email], firstName: input.firstName, lastName: input.lastName, phone: input.phone, source: "globalchurch" })).personId;
    }
    const person: any = await (getDb() as any).selectFrom("people").select(["id", "membershipStatus", "campusId", "mobilePhone"]).where("churchId", "=", churchId).where("id", "=", personId).executeTakeFirst();
    const current = String(person?.membershipStatus || "").toLowerCase();
    const upgraded = UPGRADE.has(current);
    const set: Record<string, any> = {};
    if (upgraded) set.membershipStatus = "Member";
    const online = await CrmMembership.onlineCampusId(repos, churchId);
    if (!person?.campusId && online) set.campusId = online;
    if (input.phone && !person?.mobilePhone) set.mobilePhone = String(input.phone).slice(0, 21);
    if (Object.keys(set).length) await (getDb() as any).updateTable("people").set(set).where("churchId", "=", churchId).where("id", "=", personId).execute();

    const prof = await repos.crm.loadProfile(churchId, personId);
    const cc = /^[A-Za-z]{2}$/.test(String(input.countryCode || "")) ? String(input.countryCode).toUpperCase() : null;
    const patch: Record<string, any> = {};
    if (cc && !prof?.countryCode) { patch.countryCode = cc; patch.country = countryName(cc); }
    // Members hear from their church: joining is consent to member communication.
    if (prof?.contactConsent !== "yes") { patch.contactConsent = "yes"; patch.consentSource = "Joined the Global Church"; patch.consentAt = new Date(); }
    await repos.crm.upsertProfile(churchId, personId, patch);

    const tagId = await repos.crm.ensureTag(churchId, "Global Church member");
    await repos.crm.tagPerson(churchId, personId, tagId);
    await repos.crm.upsertActivities(churchId, personId, [
      {
        site: "church",
        type: "joined",
        refKey: "membership",
        title: "Joined the Global Church",
        detail: `Accepted What We Believe${input.beliefsVersion ? " (" + input.beliefsVersion + ")" : ""}${input.lang && input.lang !== "en" ? ", in " + input.lang : ""}`,
        url: (process.env.GLOBAL_CHURCH_URL || "https://globalchurch.mbmonline.global"),
        occurredAt: new Date()
      }
    ]);
    await repos.crm.refreshLastActive(churchId, personId);
    return { personId, status: upgraded ? "Member" : person?.membershipStatus || "Member", campusId: set.campusId || person?.campusId || null, upgraded };
  }
}
