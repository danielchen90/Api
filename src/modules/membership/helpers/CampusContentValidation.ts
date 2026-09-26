import { HIDDEN, resolveForCampus, type CampusContentFields } from "./CampusContentResolver.js";

/**
 * CampusContentValidation: the pure (DB-free) half of the campusContent write + public read.
 *
 *   - CAMPUS_CONTENT_KEYS: the positive whitelist of publishable keys. It is BOTH the write
 *     filter (normalizeOverride keeps only these) and the anonymous DTO projection. A stray/new
 *     key can never reach the public surface because it is never named here.
 *   - validateCampusContent: field-level validation for the admin write (photos, leaders, phone,
 *     email, whatToExpect). Returns the cleaned (trimmed) field-set plus human-readable errors.
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
  "whatToExpect"
];

export const MAX_PHOTOS = 12;

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
export function toPublicCampusContent(resolved: CampusContentFields | null | undefined): Partial<CampusContentFields> {
  const out: any = {};
  if (!resolved) return out;
  for (const key of CAMPUS_CONTENT_KEYS) {
    const v = (resolved as any)[key];
    if (v === undefined) continue;
    if (v === HIDDEN) {
      out[key] = key === "serviceTimes" || key === "extraLinks" || key === "photos" ? [] : "";
      continue;
    }
    out[key] = v;
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
  campusIds: string[]
): Record<string, Partial<CampusContentFields>> {
  const result: Record<string, Partial<CampusContentFields>> = {};
  for (const id of campusIds) {
    if (!id) continue;
    result[id] = toPublicCampusContent(resolveForCampus(orgDefault, overrides[id] ?? null));
  }
  return result;
}
