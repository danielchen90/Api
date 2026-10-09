import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { FileStorageHelper } from "@churchapps/apihelper";
import { Repos } from "../../repositories/Repos.js";
import { Environment } from "../index.js";
import { CrmConfig } from "./CrmConfig.js";
import { CrmPeople, normEmail } from "./CrmPeople.js";
import { CrmAiError, stripDashes } from "./CrmAiService.js";
import { countryName, languageName } from "./CrmSyncService.js";

/**
 * The event planner: an event (Bible study, conference, fast track, service), its public landing
 * page and registration form, and sign-ups that land in the CRM.
 *
 * Times are stored as UTC instants plus the host's IANA time zone; every screen and email shows a
 * time in the reader's own zone. The landing page copy and the form's extra questions are drafted
 * by Claude from the event details and then edited by staff. A registration finds or creates the
 * person (a CRM contact, source "event"), fills blanks on their profile, tags them with the event,
 * and records it on their timeline; the event's confirmation email follows (CrmEventMailer).
 */

export const EVENT_KINDS = ["study", "conference", "fasttrack", "service", "other"] as const;
export const KIND_LABEL: Record<string, string> = { study: "Bible study", conference: "Conference", fasttrack: "Fast track", service: "Service", other: "Event" };
export const MINISTRY_ROLES = [
  "Apostle", "Bishop", "Pastor", "Prophet", "Evangelist", "Teacher", "Minister", "Elder", "Deacon", "Church leader", "Worship leader", "Church member", "Not yet in a church", "Other"
];

const clip = (v: any, n: number) => (v === null || v === undefined ? null : String(v).trim().slice(0, n) || null);
const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };
const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "event";

export const publicSiteUrl = () => (process.env.PUBLIC_SITE_URL || "https://church.chensolutions.com").replace(/\/+$/, "");
export const eventUrl = (slug: string) => `${publicSiteUrl()}/e/${slug}`;

export class EventError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

const Page = z.object({
  headline: z.string(),
  intro: z.string(),
  highlights: z.array(z.string()),
  topics: z.array(z.object({ title: z.string(), detail: z.string() })),
  whoShouldCome: z.string(),
  faq: z.array(z.object({ q: z.string(), a: z.string() })),
  closing: z.string()
});
const Question = z.object({ id: z.string(), label: z.string(), type: z.enum(["text", "textarea", "select", "yesno"]), options: z.array(z.string()), required: z.boolean() });
const Draft = z.object({ page: Page, questions: z.array(Question) });
export type EventPage = z.infer<typeof Page>;
export type EventQuestion = z.infer<typeof Question>;

const str = { type: "string" };
const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["page", "questions"],
  properties: {
    page: {
      type: "object",
      additionalProperties: false,
      required: ["headline", "intro", "highlights", "topics", "whoShouldCome", "faq", "closing"],
      properties: {
        headline: str,
        intro: str,
        whoShouldCome: str,
        closing: str,
        highlights: { type: "array", items: str },
        topics: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "detail"], properties: { title: str, detail: str } } },
        faq: { type: "array", items: { type: "object", additionalProperties: false, required: ["q", "a"], properties: { q: str, a: str } } }
      }
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "type", "options", "required"],
        properties: { id: str, label: str, type: { type: "string", enum: ["text", "textarea", "select", "yesno"] }, options: { type: "array", items: str }, required: { type: "boolean" } }
      }
    }
  }
};

export class CrmEventService {
  constructor(private repos: Repos) {}

  private async churchId(): Promise<string> {
    const id = await CrmConfig.churchId(this.repos);
    if (!id) throw new EventError(503, "no_church");
    return id;
  }

  async churchIdOrNull(): Promise<string | null> {
    return CrmConfig.churchId(this.repos);
  }

  async uniqueSlug(churchId: string, base: string, exceptId?: string): Promise<string> {
    const root = slugify(base);
    let slug = root;
    for (let i = 2; await this.repos.crmEvent.slugTaken(churchId, slug, exceptId); i++) slug = `${root}-${i}`;
    return slug;
  }

  /** Whitelisted, validated event fields from a request body. */
  sanitize(body: any): Record<string, any> {
    const b = body || {};
    const out: Record<string, any> = {};
    if ("title" in b) { out.title = clip(b.title, 200); if (!out.title) throw new EventError(400, "title_required"); }
    if ("kind" in b) out.kind = EVENT_KINDS.includes(b.kind) ? b.kind : "other";
    if ("status" in b) out.status = ["draft", "published", "closed"].includes(b.status) ? b.status : "draft";
    for (const [k, n] of [["subtitle", 300], ["schedule", 300], ["location", 300], ["joinUrl", 500], ["languages", 255], ["flyerUrl", 500], ["imageUrl", 500]] as const) if (k in b) out[k] = clip(b[k], n);
    if ("message" in b) out.message = clip(b.message, 60000);
    if ("timezone" in b) { if (!validTz(b.timezone)) throw new EventError(400, "bad_timezone"); out.timezone = b.timezone; }
    for (const k of ["startsAt", "endsAt"]) {
      if (k in b) {
        if (!b[k]) out[k] = null;
        else { const d = new Date(b[k]); if (isNaN(d.getTime())) throw new EventError(400, "bad_" + k); out[k] = d; }
      }
    }
    if ("capacity" in b) out.capacity = b.capacity ? Math.max(1, Math.min(1000000, Math.round(Number(b.capacity)) || 0)) || null : null;
    if ("registrationOpen" in b) out.registrationOpen = !!b.registrationOpen;
    if ("topics" in b) out.topics = Array.isArray(b.topics) ? b.topics.slice(0, 40).map((t: any) => ({ title: String(t?.title || "").slice(0, 200), detail: String(t?.detail || "").slice(0, 2000) })).filter((t: any) => t.title) : [];
    if ("speakers" in b) out.speakers = Array.isArray(b.speakers) ? b.speakers.slice(0, 30).map((s: any) => ({ name: String(s?.name || "").slice(0, 120), role: String(s?.role || "").slice(0, 160) })).filter((s: any) => s.name) : [];
    if ("page" in b) { const p = Page.safeParse(b.page); out.page = p.success ? p.data : null; }
    if ("questions" in b) {
      const q = z.array(Question).safeParse((b.questions || []).map((x: any, i: number) => ({ id: String(x?.id || "q" + (i + 1)).slice(0, 40), label: String(x?.label || "").slice(0, 300), type: x?.type, options: Array.isArray(x?.options) ? x.options.map(String).slice(0, 30) : [], required: !!x?.required })));
      out.questions = q.success ? q.data.filter((x) => x.label) : [];
    }
    if (out.startsAt && out.endsAt && out.endsAt < out.startsAt) throw new EventError(400, "ends_before_start");
    return out;
  }

  async create(churchId: string, body: any, userId: string): Promise<string> {
    const fields = this.sanitize({ kind: "study", ...body });
    if (!fields.title) throw new EventError(400, "title_required");
    fields.slug = await this.uniqueSlug(churchId, body.slug || fields.title);
    fields.createdBy = userId;
    fields.status = "draft";
    fields.tagId = await this.repos.crm.ensureTag(churchId, "Event: " + fields.title.slice(0, 50));
    const id = await this.repos.crmEvent.create(churchId, fields);
    const { CrmEventMailer } = await import("./CrmEventMailer.js");
    await CrmEventMailer.createDefaults(this.repos, churchId, id);
    return id;
  }

  async update(churchId: string, id: string, body: any): Promise<any> {
    const ev = await this.repos.crmEvent.load(churchId, id);
    if (!ev) throw new EventError(404, "not_found");
    const fields = this.sanitize(body);
    if (body?.slug && slugify(body.slug) !== ev.slug) fields.slug = await this.uniqueSlug(churchId, body.slug, id);
    if (fields.status === "published") {
      const merged = { ...ev, ...fields };
      if (!merged.startsAt) throw new EventError(400, "needs_start");
    }
    await this.repos.crmEvent.update(churchId, id, fields);
    return this.repos.crmEvent.load(churchId, id);
  }

  /** Claude drafts the landing page and the extra registration questions from the event details. */
  async draftPage(churchId: string, id: string): Promise<any> {
    if (!CrmConfig.aiConfigured) throw new CrmAiError(503, "ai_not_configured");
    const ev = await this.repos.crmEvent.load(churchId, id);
    if (!ev) throw new EventError(404, "not_found");
    const when = ev.startsAt ? new Date(ev.startsAt).toLocaleString("en-US", { timeZone: ev.timezone, dateStyle: "full", timeStyle: "short" }) + ` (${ev.timezone})` : "not set yet";
    const details = [
      `Kind: ${KIND_LABEL[ev.kind] || ev.kind}`,
      `Title: ${ev.title}`,
      ev.subtitle ? `Subtitle: ${ev.subtitle}` : "",
      `Starts: ${when}`,
      ev.schedule ? `Schedule: ${ev.schedule}` : "",
      ev.location ? `Where: ${ev.location}` : "",
      ev.languages ? `Languages offered: ${ev.languages}` : "",
      ev.speakers?.length ? "Ministering: " + ev.speakers.map((s: any) => s.name + (s.role ? ` (${s.role})` : "")).join("; ") : "",
      ev.topics?.length ? "Topics:\n" + ev.topics.map((t: any) => `- ${t.title}${t.detail ? ": " + t.detail : ""}`).join("\n") : "",
      ev.message ? "The message (the ministry's own words):\n" + ev.message : ""
    ].filter(Boolean).join("\n");
    const msg = await new Anthropic().beta.messages.create({
      model: CrmConfig.aiModel,
      max_tokens: 12000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: DRAFT_SCHEMA as any } },
      system: [
        "You write the public registration page for an event of a Christian teaching ministry (Apostle Mary Banks, Bible Teachers International / Mary Banks Ministries).",
        "The readers are people from many countries, many reading English as a second language and with different levels of schooling: use short sentences and plain, warm words. No hype.",
        "Keep the ministry's own topics, titles and scripture references exactly; you may explain them in one or two sentences each. Never invent dates, speakers, prices, places or promises that are not in the details.",
        "headline: under 12 words. intro: 2 to 4 sentences. highlights: 3 to 6 short lines on what to expect. whoShouldCome: 1 to 2 sentences. faq: 3 to 6 practical questions (time zones, language, cost only if stated, how to join, bringing others). closing: one sentence inviting them to register.",
        "questions: 0 to 4 extra registration questions this event needs beyond name, email, phone, country, city, language, ministry role and church, consent and group size (all asked already). Ids in lower_snake_case.",
        "Do not mention Bible translation names. Never use em dashes or en dashes."
      ].join("\n"),
      messages: [{ role: "user", content: "<event>\n" + details + "\n</event>" }]
    });
    if (msg.stop_reason === "refusal") throw new CrmAiError(422, "ai_refused");
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    const parsed = Draft.safeParse(JSON.parse(text || "{}"));
    if (!parsed.success) throw new CrmAiError(502, "ai_bad_output");
    const d = parsed.data;
    const clean = (s: string) => stripDashes(s);
    const page: EventPage = {
      headline: clean(d.page.headline),
      intro: clean(d.page.intro),
      whoShouldCome: clean(d.page.whoShouldCome),
      closing: clean(d.page.closing),
      highlights: d.page.highlights.map(clean),
      topics: d.page.topics.map((t) => ({ title: clean(t.title), detail: clean(t.detail) })),
      faq: d.page.faq.map((f) => ({ q: clean(f.q), a: clean(f.a) }))
    };
    const questions = d.questions.map((q) => ({ ...q, label: clean(q.label), id: slugify(q.id).replace(/-/g, "_").slice(0, 40) || "q" }));
    await this.repos.crmEvent.update(churchId, id, { page, questions });
    return { page, questions };
  }

  /** Store a flyer (image or PDF) in the content store; an image also becomes the page's picture. */
  async uploadFlyer(churchId: string, id: string, file: { data: string; mediaType: string; name?: string }): Promise<any> {
    const ev = await this.repos.crmEvent.load(churchId, id);
    if (!ev) throw new EventError(404, "not_found");
    const types: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
    const ext = types[file?.mediaType];
    if (!ext || !file.data) throw new EventError(400, "bad_file");
    const buf = Buffer.from(String(file.data).replace(/^data:[^,]+,/, ""), "base64");
    if (buf.length > 15 * 1024 * 1024) throw new EventError(400, "too_large");
    const key = `${churchId}/crm/events/${id}/flyer-${Date.now()}.${ext}`;
    await FileStorageHelper.store(key, file.mediaType, buf);
    const url = (Environment.contentRoot || "").replace(/\/+$/, "") + "/" + key;
    const patch: any = { flyerUrl: url };
    if (ext !== "pdf") patch.imageUrl = url;
    await this.repos.crmEvent.update(churchId, id, patch);
    return this.repos.crmEvent.load(churchId, id);
  }

  /** The public view of a published event (no join link, no internal fields). */
  publicView(ev: any, registered: number) {
    const full = !!ev.capacity && registered >= ev.capacity;
    return {
      slug: ev.slug,
      kind: ev.kind,
      kindLabel: KIND_LABEL[ev.kind] || "Event",
      title: ev.title,
      subtitle: ev.subtitle,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      timezone: ev.timezone,
      schedule: ev.schedule,
      location: ev.location,
      languages: ev.languages,
      topics: ev.topics || [],
      speakers: ev.speakers || [],
      page: ev.page,
      questions: ev.questions || [],
      flyerUrl: ev.flyerUrl,
      imageUrl: ev.imageUrl,
      registrationOpen: ev.status === "published" && ev.registrationOpen && !full,
      full,
      closed: ev.status === "closed",
      roles: MINISTRY_ROLES,
      url: eventUrl(ev.slug)
    };
  }

  async publicEvent(slug: string) {
    const churchId = await this.churchId();
    const ev = await this.repos.crmEvent.loadBySlug(churchId, String(slug || "").slice(0, 80));
    if (!ev || ev.status === "draft") throw new EventError(404, "not_found");
    return this.publicView(ev, await this.repos.crmEvent.countRegistrations(ev.id));
  }

  /** A public sign-up. Returns the join link and the event's local time for the thank-you screen. */
  async register(slug: string, body: any): Promise<any> {
    const churchId = await this.churchId();
    const ev = await this.repos.crmEvent.loadBySlug(churchId, String(slug || "").slice(0, 80));
    if (!ev || ev.status === "draft") throw new EventError(404, "not_found");
    if (ev.status !== "published" || !ev.registrationOpen) throw new EventError(409, "registration_closed");

    const b = body || {};
    const email = normEmail(b.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 191) throw new EventError(400, "email");
    const firstName = clip(b.firstName, 50);
    if (!firstName) throw new EventError(400, "first_name");
    const existing = await this.repos.crmEvent.registrationByEmail(ev.id, email);
    if (!existing || existing.status === "cancelled") {
      if (ev.capacity && (await this.repos.crmEvent.countRegistrations(ev.id)) >= ev.capacity) throw new EventError(409, "full");
    }
    const countryCode = /^[A-Za-z]{2}$/.test(String(b.countryCode || "")) ? String(b.countryCode).toUpperCase() : null;
    const timezone = b.timezone && validTz(b.timezone) ? String(b.timezone) : null;
    const answers: Record<string, string> = {};
    for (const q of (ev.questions || []) as EventQuestion[]) {
      const v = clip(b.answers?.[q.id], 2000);
      if (q.required && !v) throw new EventError(400, "answer:" + q.id);
      if (v) answers[q.id] = v;
    }
    const reg = {
      eventId: ev.id,
      email,
      firstName,
      lastName: clip(b.lastName, 50),
      phone: clip(b.phone, 40),
      countryCode,
      city: clip(b.city, 80),
      timezone,
      language: clip(b.language, 40),
      ministryRole: clip(b.ministryRole, 120),
      organization: clip(b.organization, 150),
      groupSize: b.groupSize ? Math.max(1, Math.min(10000, Math.round(Number(b.groupSize)) || 1)) : null,
      answers,
      contactConsent: !!b.contactConsent,
      status: "registered",
      source: clip(b.source, 30) || "page"
    };

    const person = await CrmPeople.ensure(this.repos, { churchId, emails: [email], firstName, lastName: reg.lastName, phone: reg.phone, source: "event" });
    const regId = await this.repos.crmEvent.saveRegistration(churchId, { ...reg, personId: person.personId }, existing?.id);

    // Fill blanks on the profile; consent only ever turns on from a form (never off).
    const prof = await this.repos.crm.loadProfile(churchId, person.personId);
    const patch: Record<string, any> = {};
    if (countryCode && !prof?.countryCode) { patch.countryCode = countryCode; patch.country = countryName(countryCode); }
    if (reg.city && !prof?.city) patch.city = reg.city;
    if (timezone && !prof?.timezone) patch.timezone = timezone;
    if (reg.language && !(prof?.languages || "").toLowerCase().includes(reg.language.toLowerCase())) patch.languages = [prof?.languages, languageName(reg.language) || reg.language].filter(Boolean).join(", ").slice(0, 255);
    if (reg.ministryRole && !prof?.ministryRole) patch.ministryRole = reg.ministryRole;
    if (reg.organization && !prof?.organization) patch.organization = reg.organization;
    if (reg.contactConsent && prof?.contactConsent !== "yes") { patch.contactConsent = "yes"; patch.consentSource = ("Registration: " + ev.title).slice(0, 80); patch.consentAt = new Date(); }
    await this.repos.crm.upsertProfile(churchId, person.personId, patch);
    if (ev.tagId) await this.repos.crm.tagPerson(churchId, person.personId, ev.tagId);
    await this.repos.crm.upsertActivities(churchId, person.personId, [
      {
        site: "event",
        type: "registered",
        refKey: "reg:" + regId,
        title: ev.title,
        detail: [KIND_LABEL[ev.kind], reg.groupSize && reg.groupSize > 1 ? `bringing ${reg.groupSize}` : null].filter(Boolean).join(", "),
        url: eventUrl(ev.slug),
        occurredAt: new Date()
      }
    ]);
    await this.repos.crm.refreshLastActive(churchId, person.personId);

    if (!existing || existing.status === "cancelled") {
      const { CrmEventMailer } = await import("./CrmEventMailer.js");
      CrmEventMailer.sendConfirmation(this.repos, churchId, ev.id, regId).catch((e) => console.error("[crm-events] confirmation failed:", e?.message || e));
    }
    return { ok: true, again: !!existing && existing.status !== "cancelled", joinUrl: ev.joinUrl || null };
  }
}
