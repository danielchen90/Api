import crypto from "crypto";
import { HIDDEN, resolveForCampus, type CampusContentFields, type Announcement } from "./CampusContentResolver.js";

/**
 * CampusContentValidation: the pure (DB-free) half of the campusContent write + public read.
 *
 *   - CAMPUS_CONTENT_KEYS: the positive whitelist of publishable keys. It is BOTH the write
 *     filter (normalizeOverride keeps only these) and the anonymous DTO projection. A stray/new
 *     key can never reach the public surface because it is never named here.
 *   - validateCampusContent: field-level validation for the admin write (photos, leaders, phone,
 *     email, whatToExpect, announcements). Returns the cleaned (trimmed) field-set plus human-readable errors.
 *   - toPublicCampusContent / resolveAllForChurch: the anonymous projection (single + bulk).
 *
 * Kept free of controller/repo imports so the leak + validation suites can drive it directly.
 */

export const CAMPUS_CONTENT_KEYS: (keyof CampusContentFields)[] = [
  "mission",
  "about",
  "welcomeNote",
  "pastorNote",
  "heroImage",
  "serviceTimes",
  "facebookUrl",
  "instagramUrl",
  "youtubeUrl",
  "givingUrl",
  "sermonYoutubeChannel",
  "extraLinks",
  "photos",
  "leaders",
  "phone",
  "email",
  "whatToExpect",
  "announcements"
];

export const MAX_PHOTOS = 12;
export const MAX_ANNOUNCEMENTS = 10;
export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 1500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Plain text only: drop anything that looks like an HTML tag and control characters (keeps \n).
function plainText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .trim();
}

/** Validate + clean the announcements list. Returns the cleaned list (ids assigned when missing). */
export function validateAnnouncements(input: any, errors: string[]): Announcement[] {
  if (!Array.isArray(input)) {
    errors.push("Announcements must be a list.");
    return [];
  }
  const out: Announcement[] = [];
  const seen = new Set<string>();
  input.forEach((raw: any, i: number) => {
    const n = i + 1;
    if (!raw || typeof raw !== "object") {
      errors.push(`Announcement ${n} is not valid.`);
      return;
    }
    const title = typeof raw.title === "string" ? plainText(raw.title).replace(/\n+/g, " ") : "";
    const body = typeof raw.body === "string" ? plainText(raw.body) : "";
    const startsOn = typeof raw.startsOn === "string" && raw.startsOn.trim() ? raw.startsOn.trim().slice(0, 10) : null;
    const endsOn = typeof raw.endsOn === "string" && raw.endsOn.trim() ? raw.endsOn.trim().slice(0, 10) : null;
    if (!title && !body && !startsOn && !endsOn) return; // an empty row the editor left behind
    if (!title) errors.push(`Announcement ${n} needs a title.`);
    if (title.length > ANNOUNCEMENT_TITLE_MAX) errors.push(`Announcement ${n}: the title can be at most ${ANNOUNCEMENT_TITLE_MAX} characters.`);
    if (body.length > ANNOUNCEMENT_BODY_MAX) errors.push(`Announcement ${n}: the text can be at most ${ANNOUNCEMENT_BODY_MAX} characters.`);
    if (startsOn && !validDate(startsOn)) errors.push(`Announcement ${n}: "show from" is not a valid date.`);
    if (endsOn && !validDate(endsOn)) errors.push(`Announcement ${n}: "show until" is not a valid date.`);
    if (startsOn && endsOn && validDate(startsOn) && validDate(endsOn) && endsOn < startsOn) errors.push(`Announcement ${n}: "show until" is before "show from".`);
    let id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(raw.id) ? raw.id : "";
    if (!id || seen.has(id)) id = crypto.randomBytes(8).toString("base64url").slice(0, 11);
    seen.add(id);
    const a: Announcement = { id, title, body };
    if (startsOn) a.startsOn = startsOn;
    if (endsOn) a.endsOn = endsOn;
    out.push(a);
  });
  if (out.length > MAX_ANNOUNCEMENTS) errors.push(`A center can have at most ${MAX_ANNOUNCEMENTS} announcements.`);
  return out;
}

/**
 * Announcements whose window includes "today". Dates are calendar days with no time zone, so
 * "today" is taken generously: a start date counts once it has begun anywhere on Earth (UTC+14)
 * and an end date lasts until it has ended everywhere (UTC-12).
 */
export function currentAnnouncements(list: Announcement[] | null | undefined, now: Date = new Date()): Announcement[] {
  if (!Array.isArray(list)) return [];
  const earliestToday = new Date(now.getTime() + 14 * 3600 * 1000).toISOString().slice(0, 10);
  const latestToday = new Date(now.getTime() - 12 * 3600 * 1000).toISOString().slice(0, 10);
  return list
    .filter((a) => a && typeof a.title === "string" && a.title)
    .filter((a) => (!a.startsOn || a.startsOn <= earliestToday) && (!a.endsOn || a.endsOn >= latestToday))
    .map((a) => {
      const pub: Announcement = { id: String(a.id || ""), title: a.title, body: typeof a.body === "string" ? a.body : "" };
      if (a.startsOn) pub.startsOn = a.startsOn;
      if (a.endsOn) pub.endsOn = a.endsOn;
      return pub;
    });
}

// Max lengths for the plain-text contact fields.
const TEXT_LIMITS: Partial<Record<keyof CampusContentFields, number>> = {
  leaders: 200,
  phone: 40,
  email: 120,
  whatToExpect: 2000
};

const TEXT_LABELS: Partial<Record<keyof CampusContentFields, string>> = {
  leaders: "Pastor(s)",
  phone: "Phone",
  email: "Email",
  whatToExpect: "Your first visit"
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export interface CampusContentValidationResult {
  content: CampusContentFields;
  errors: string[];
}

/**
 * Validate + clean an incoming content field-set (admin write). Unknown keys are ignored here
 * (normalizeOverride drops them). HIDDEN is always accepted. Only the fields this validator knows
 * are rewritten; every other whitelisted field passes through unchanged.
 */
export function validateCampusContent(input: any): CampusContentValidationResult {
  const errors: string[] = [];
  const content: any = { ...(input && typeof input === "object" ? input : {}) };

  // photos: string[] of http(s) URLs, trimmed, blanks dropped, max 12.
  if (content.photos !== undefined && content.photos !== null && content.photos !== HIDDEN) {
    if (!Array.isArray(content.photos)) {
      errors.push("Photos must be a list of image links.");
    } else {
      const cleaned: string[] = [];
      for (const p of content.photos) {
        if (typeof p !== "string") {
          errors.push("Each photo must be an image link.");
          continue;
        }
        const t = p.trim();
        if (!t) continue;
        if (!isHttpUrl(t)) {
          errors.push("Photo link is not a valid web address: " + t.slice(0, 80));
          continue;
        }
        cleaned.push(t);
      }
      if (cleaned.length > MAX_PHOTOS) errors.push(`A center can have at most ${MAX_PHOTOS} photos.`);
      content.photos = cleaned;
    }
  }

  // announcements: max 10, plain text, optional date window.
  if (content.announcements !== undefined && content.announcements !== null && content.announcements !== HIDDEN) {
    content.announcements = validateAnnouncements(content.announcements, errors);
  }

  // Plain-text contact fields.
  for (const key of Object.keys(TEXT_LIMITS) as (keyof CampusContentFields)[]) {
    const val = content[key];
    if (val === undefined || val === null || val === HIDDEN) continue;
    if (typeof val !== "string") {
      errors.push(`${TEXT_LABELS[key]} must be text.`);
      continue;
    }
    let t = val.trim();
    if (key === "whatToExpect") t = t.replace(/\r\n?/g, "\n");
    const max = TEXT_LIMITS[key] as number;
    if (t.length > max) errors.push(`${TEXT_LABELS[key]} can be at most ${max} characters.`);
    if (key === "email" && t && !EMAIL_RE.test(t)) errors.push("Email is not a valid email address.");
    content[key] = t;
  }

  return { content, errors };
}

/**
 * Anonymous projection: the positive whitelist, with any stray HIDDEN sentinel (e.g. saved on the
 * org default) rendered as its blank value so the sentinel string itself never reaches a visitor.
 */
export function toPublicCampusContent(resolved: CampusContentFields | null | undefined, now: Date = new Date()): Partial<CampusContentFields> {
  const out: any = {};
  if (!resolved) return out;
  for (const key of CAMPUS_CONTENT_KEYS) {
    const v = (resolved as any)[key];
    if (v === undefined) continue;
    if (v === HIDDEN) {
      out[key] = key === "serviceTimes" || key === "extraLinks" || key === "photos" || key === "announcements" ? [] : "";
      continue;
    }
    // Announcements: only the ones in their date window, each projected field by field.
    out[key] = key === "announcements" ? currentAnnouncements(v, now) : v;
  }
  return out;
}

/**
 * Bulk resolve for the public home page: `{ [campusId]: resolvedContent }` for every listed campus.
 * `overrides` maps campusId → that campus's sparse override (absent → pure org default).
 */
export function resolveAllForChurch(
  orgDefault: CampusContentFields | null | undefined,
  overrides: Record<string, CampusContentFields | null | undefined>,
  campusIds: string[],
  now: Date = new Date()
): Record<string, Partial<CampusContentFields>> {
  const result: Record<string, Partial<CampusContentFields>> = {};
  for (const id of campusIds) {
    if (!id) continue;
    result[id] = toPublicCampusContent(resolveForCampus(orgDefault, overrides[id] ?? null), now);
  }
  return result;
}
