import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { Repos } from "../../repositories/Repos.js";
import { CrmConfig } from "./CrmConfig.js";
import { countryName } from "./CrmSyncService.js";

/**
 * The CRM's AI (Claude): quick capture, the person summary, and "Ask the CRM".
 *
 *   extract()   a pasted conversation, notes and/or screenshots -> contact details, location,
 *               languages, ministry role, prayer requests, needs, interests, follow-ups, plus a
 *               plain transcript of any screenshot. Staff apply it; nothing is guessed: a value the
 *               text does not state comes back null.
 *   summarize() a short profile of the person from everything the CRM holds.
 *   ask()       answers staff questions ("the pastor from Uganda?", "what did he ask prayer for?")
 *               with tools that search people and read one person's record.
 *
 * Ask Mary conversations are NOT available here: the CRM only ever holds their topics.
 * Opus 5.5 with server-side refusal fallback; no em dashes in anything it writes.
 */

const NO_DASH = "Never use em dashes or en dashes; use commas, colons or separate sentences instead.";
const BETAS: Anthropic.Beta.AnthropicBeta[] = ["server-side-fallback-2026-07-01"];

export const stripDashes = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",");

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, "null"], ...extra });

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["transcript", "person", "facts", "tags", "noteSummary"],
  properties: {
    transcript: nullable("string", { description: "Plain-text transcript of the screenshots (who said what), or null when there were none." }),
    noteSummary: { type: "string", description: "Two or three sentences: what this capture tells us about the person." },
    person: {
      type: "object",
      additionalProperties: false,
      required: ["firstName", "lastName", "emails", "phones", "countryCode", "city", "region", "timezone", "languages", "ministryRole", "organization", "contactConsent"],
      properties: {
        firstName: nullable("string"),
        lastName: nullable("string"),
        emails: { type: "array", items: { type: "string" } },
        phones: { type: "array", items: { type: "string" }, description: "With country code when known, e.g. +256 772 123456" },
        countryCode: nullable("string", { description: "ISO 3166-1 alpha-2, e.g. UG" }),
        city: nullable("string"),
        region: nullable("string"),
        timezone: nullable("string", { description: "IANA zone only when the place makes it certain, e.g. Africa/Kampala" }),
        languages: { type: "array", items: { type: "string" }, description: "Languages the person speaks, in English, e.g. Luganda" },
        ministryRole: nullable("string", { description: "e.g. Pastor, Evangelist, Bishop, worship leader" }),
        organization: nullable("string", { description: "Church or ministry they belong to or lead" }),
        contactConsent: { type: "string", enum: ["yes", "no", "unknown"], description: "yes only when they clearly agreed to hear about future events or studies; no when they declined" }
      }
    },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text"],
        properties: {
          kind: { type: "string", enum: ["prayer", "need", "interest", "fact", "followup"] },
          text: { type: "string", description: "One short sentence in English" }
        }
      }
    },
    tags: { type: "array", items: { type: "string" }, description: "0 to 4 short grouping tags, e.g. Pastor, Uganda, Conference 2026" }
  }
} as const;

const Extract = z.object({
  transcript: z.string().nullable(),
  noteSummary: z.string(),
  person: z.object({
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    emails: z.array(z.string()),
    phones: z.array(z.string()),
    countryCode: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    timezone: z.string().nullable(),
    languages: z.array(z.string()),
    ministryRole: z.string().nullable(),
    organization: z.string().nullable(),
    contactConsent: z.enum(["yes", "no", "unknown"])
  }),
  facts: z.array(z.object({ kind: z.enum(["prayer", "need", "interest", "fact", "followup"]), text: z.string() })),
  tags: z.array(z.string())
});
export type Extraction = z.infer<typeof Extract>;

export interface CaptureImage { mediaType: string; data: string }

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export class CrmAiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

function client(): Anthropic {
  if (!CrmConfig.aiConfigured) throw new CrmAiError(503, "ai_not_configured");
  return new Anthropic();
}

function textOf(msg: Anthropic.Beta.BetaMessage): string {
  if (msg.stop_reason === "refusal") throw new CrmAiError(422, "ai_refused");
  return msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
}

export class CrmAiService {
  constructor(private repos: Repos) {}

  async extract(input: { text?: string; images?: CaptureImage[]; knownName?: string | null; today?: string }): Promise<Extraction> {
    const images = (input.images || []).filter((i) => IMAGE_TYPES.has(i.mediaType) && i.data).slice(0, 6);
    const text = (input.text || "").trim().slice(0, 40000);
    if (!text && !images.length) throw new CrmAiError(400, "empty");
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: img.mediaType as any, data: img.data.replace(/^data:[^,]+,/, "") } });
    content.push({
      type: "text",
      text: [
        input.knownName ? `This capture is about ${input.knownName}.` : "This capture is about one person the ministry met (the other party in the conversation, not the ministry worker).",
        `Today is ${input.today || new Date().toISOString().slice(0, 10)}.`,
        text ? "Notes / pasted conversation:\n<capture>\n" + text + "\n</capture>" : "The capture is the screenshot(s) above."
      ].join("\n")
    });
    const msg = await client().beta.messages.create({
      model: CrmConfig.aiModel,
      max_tokens: 8000,
      betas: BETAS,
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: EXTRACT_SCHEMA as any } },
      system: [
        "You keep the contact records of a Christian teaching ministry (Mary Banks Ministries / Bible Teachers International).",
        "A staff member pastes notes, a chat transcript or screenshots of a conversation (WhatsApp, Messenger, email) with someone they met.",
        "Pull out only what the material states about that person. Leave a field null or empty when it is not stated; never guess a name, number or place.",
        "Prayer requests, needs and follow-ups are worth the most: record each one as its own short fact in English, with names and places kept.",
        "Translate facts to English when the conversation is in another language; keep names as written.",
        NO_DASH
      ].join("\n"),
      messages: [{ role: "user", content }]
    });
    const parsed = Extract.safeParse(JSON.parse(textOf(msg) || "{}"));
    if (!parsed.success) throw new CrmAiError(502, "ai_bad_output");
    const out = parsed.data;
    out.noteSummary = stripDashes(out.noteSummary);
    out.facts = out.facts.map((f) => ({ ...f, text: stripDashes(f.text) })).filter((f) => f.text.trim());
    out.person.countryCode = /^[A-Za-z]{2}$/.test(out.person.countryCode || "") ? out.person.countryCode!.toUpperCase() : null;
    return out;
  }

  /** Everything the CRM knows about one person, as plain text for the model. */
  async dossier(churchId: string, personId: string): Promise<string> {
    const p: any = await this.repos.person.load(churchId, personId);
    if (!p) return "";
    const prof = await this.repos.crm.loadProfile(churchId, personId);
    const tags = await this.repos.crm.loadPersonTags(churchId, personId);
    const facts = await this.repos.crm.loadFacts(churchId, personId);
    const notes = await this.repos.crm.loadNotes(churchId, personId, 30);
    const acts = await this.repos.crm.loadActivities(churchId, personId, 80);
    const d = (v: any) => (v ? new Date(v).toISOString().slice(0, 10) : "");
    const lines = [
      `Name: ${p.displayName || [p.firstName, p.lastName].filter(Boolean).join(" ")}`,
      `Status: ${p.membershipStatus || "unknown"}${p.mbidSub ? ", has a Mary Banks ID" : ""}`,
      p.email ? `Email: ${p.email}` : "",
      p.mobilePhone || p.homePhone ? `Phone: ${p.mobilePhone || p.homePhone}` : "",
      prof?.country || prof?.city ? `Location: ${[prof?.city, prof?.region, prof?.country].filter(Boolean).join(", ")}` : "",
      prof?.timezone ? `Time zone: ${prof.timezone}` : "",
      prof?.languages ? `Languages: ${prof.languages}` : "",
      prof?.ministryRole || prof?.organization ? `Ministry: ${[prof?.ministryRole, prof?.organization].filter(Boolean).join(", ")}` : "",
      `Contact consent: ${prof?.contactConsent || "unknown"}`,
      tags.length ? `Tags: ${tags.map((t) => t.name).join(", ")}` : "",
      facts.length ? "Facts:\n" + facts.map((f) => `- [${f.kind}${f.status === "done" ? ", done" : ""}] ${f.text} (${d(f.createdAt)})`).join("\n") : "",
      notes.length ? "Notes (newest first):\n" + notes.map((n) => `- ${d(n.createdAt)} ${n.addedByName ? "by " + n.addedByName + ": " : ""}${String(n.body || "").slice(0, 1500)}`).join("\n") : "",
      acts.length ? "Activity on the ministry sites (newest first):\n" + acts.map((a) => `- ${d(a.occurredAt)} ${a.site}: ${a.title}${a.detail ? " (" + a.detail + ")" : ""}`).join("\n") : ""
    ];
    return lines.filter(Boolean).join("\n");
  }

  async summarize(churchId: string, personId: string): Promise<string> {
    const dossier = await this.dossier(churchId, personId);
    if (!dossier) throw new CrmAiError(404, "not_found");
    const msg = await client().beta.messages.create({
      model: CrmConfig.aiModel,
      max_tokens: 4000,
      betas: BETAS,
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [
        "Write a short profile (90 to 160 words) of one person for the staff of a Christian teaching ministry, so they can serve this person well.",
        "Say who they are, where they are, their ministry role, what they have engaged with (courses, books, services, groups), open prayer requests and needs, and a suggested next step.",
        "Use only the record below; say nothing you cannot see there. Plain prose, no headings, no bullet points. " + NO_DASH
      ].join("\n"),
      messages: [{ role: "user", content: "<record>\n" + dossier + "\n</record>" }]
    });
    const summary = stripDashes(textOf(msg));
    await this.repos.crm.upsertProfile(churchId, personId, { summary, summaryUpdatedAt: new Date() });
    return summary;
  }

  async ask(churchId: string, question: string, history: { role: "user" | "assistant"; content: string }[] = []): Promise<{ answer: string; people: { id: string; name: string }[] }> {
    const q = question.trim().slice(0, 2000);
    if (!q) throw new CrmAiError(400, "empty");
    const tools: Anthropic.Beta.BetaTool[] = [
      {
        name: "search_people",
        description: "Search the CRM. Matches name, email, phone, country, city, organization, ministry role, tags, notes, facts (prayer requests, needs) and activity titles. Returns up to 25 people with a one-line summary each. Use several short searches (e.g. 'Uganda', 'pastor') rather than one long one.",
        strict: true,
        input_schema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" } } }
      },
      {
        name: "get_person",
        description: "The full record of one person: contact details, location, ministry, tags, facts, notes and activity.",
        strict: true,
        input_schema: { type: "object", additionalProperties: false, required: ["personId"], properties: { personId: { type: "string" } } }
      }
    ];
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...history.slice(-8).map((h) => ({ role: h.role, content: String(h.content).slice(0, 4000) })),
      { role: "user", content: q }
    ];
    const seen = new Map<string, string>();
    const c = client();
    for (let turn = 0; turn < 8; turn++) {
      const msg = await c.beta.messages.create({
        model: CrmConfig.aiModel,
        max_tokens: 6000,
        betas: BETAS,
        fallbacks: "default",
        output_config: { effort: "medium" },
        tools,
        system: [
          "You help the staff of a Christian teaching ministry find people in their CRM and recall what they know about them.",
          "Always look things up with the tools before answering; never invent a person, number or detail. If nothing matches, say so and suggest another search.",
          "Answer briefly and directly in plain text (no markdown, no asterisks or headings). When you name a person, include their personId in the form [[personId]] right after the name so the screen can link it.",
          "Ask Mary chat contents are confidential and are not in the CRM; only their topics are.",
          NO_DASH
        ].join("\n"),
        messages
      });
      if (msg.stop_reason === "refusal") throw new CrmAiError(422, "ai_refused");
      messages.push({ role: "assistant", content: msg.content as any });
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!uses.length || msg.stop_reason !== "tool_use") {
        const answer = stripDashes(msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim());
        const ids = [...answer.matchAll(/\[\[([A-Za-z0-9_-]{6,20})\]\]/g)].map((m) => m[1]);
        return { answer, people: [...new Set(ids)].filter((id) => seen.has(id)).map((id) => ({ id, name: seen.get(id)! })) };
      }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const input: any = u.input || {};
        try {
          if (u.name === "search_people") {
            const rows = await this.searchForAi(churchId, String(input.query || ""));
            rows.forEach((r) => seen.set(r.id, r.name));
            results.push({ type: "tool_result", tool_use_id: u.id, content: rows.length ? rows.map((r) => r.line).join("\n") : "No matches." });
          } else if (u.name === "get_person") {
            const dossier = await this.dossier(churchId, String(input.personId || ""));
            if (dossier) seen.set(String(input.personId), dossier.split("\n")[0].replace(/^Name: /, ""));
            results.push({ type: "tool_result", tool_use_id: u.id, content: dossier || "No person with that id." });
          } else {
            results.push({ type: "tool_result", tool_use_id: u.id, content: "Unknown tool.", is_error: true });
          }
        } catch (e: any) {
          results.push({ type: "tool_result", tool_use_id: u.id, content: "Lookup failed: " + String(e?.message || e).slice(0, 200), is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    return { answer: "I could not finish that search. Please ask a narrower question.", people: [] };
  }

  /** Word search across people, profiles, tags, facts, notes and activity titles. */
  private async searchForAi(churchId: string, query: string): Promise<{ id: string; name: string; line: string }[]> {
    const words = query.toLowerCase().split(/[^\p{L}\p{N}@.+]+/u).filter((w) => w.length >= 2).slice(0, 6);
    if (!words.length) return [];
    const rows = await this.repos.crm.aiSearch(churchId, words);
    return rows.map((r: any) => {
      const place = [r.city, r.country || countryName(r.countryCode)].filter(Boolean).join(", ");
      const bits = [r.membershipStatus, place, [r.ministryRole, r.organization].filter(Boolean).join(", "), r.tags, r.email, r.mobilePhone, r.hit].filter(Boolean);
      const name = r.displayName || [r.firstName, r.lastName].filter(Boolean).join(" ") || "(no name)";
      return { id: r.id, name, line: `${r.id} | ${name} | ${bits.join(" | ")}`.slice(0, 600) };
    });
  }
}
