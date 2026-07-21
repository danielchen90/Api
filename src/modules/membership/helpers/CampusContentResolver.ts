// CMS-01 field-level content resolver. A campus's rendered public-website content
// is the org DEFAULT overlaid FIELD-BY-FIELD with that campus's SPARSE override:
//
//   resolved.field = campusOverride[field] !== undefined
//                      ? campusOverride[field]   // campus decided this field
//                      : orgDefault[field];      // inherit the org default
//
// Because overrides are stored SPARSE (only fields the campus actually changed are
// present), any field ABSENT from the override inherits the org default LIVE — an
// org-default change propagates instantly to every non-overriding campus. Writes
// (Plan 05) normalize a cleared/blank field back to "no override" (delete the key)
// so a blank campus edit re-inherits rather than blanks; the resolver only needs
// to treat an ABSENT field as inherit.
//
// EXPLICIT HIDE: a campus can force a field BLANK even though the org default is
// set (e.g. a campus that intentionally has no pastor note). This is DISTINCT from
// "inherit" (absent) and from "override with a value". It is expressed with the
// HIDDEN sentinel below: `campusOverride.field === HIDDEN` → resolved field is the
// field's blank value (empty string for scalars, empty array for lists).
//
// LIST FIELDS (serviceTimes, extraLinks) override by WHOLE-LIST REPLACEMENT — if
// the campus override provides the array, the resolved list IS that array entirely
// (no per-entry merge). Absent → inherit the org default list; HIDDEN → [].

// ── The explicit-hide sentinel. A campus field set to HIDDEN resolves BLANK even
//    when the org default has a value. Chosen as a unique string constant so it
//    survives JSON.stringify/parse round-trips in `content` (no special object). ──
export const HIDDEN = "__HIDDEN__" as const;

export interface ServiceTime {
  day: string;
  time: string;
  label?: string;
}

export interface ExtraLink {
  label: string;
  url: string;
}

// The shared, typed content field-set consumed by BOTH this resolver and the Plan
// 05 DTO. Every field is optional so an override can be SPARSE. Hero image is a
// FilesManager reference (file id / URL) — NEVER image bytes. `serviceTimes` and
// `extraLinks` are whole-list-replaced. `HIDDEN` may appear in place of any field
// on a campus override to force the resolved value blank.
export interface CampusContentFields {
  // Copy blocks.
  mission?: string | typeof HIDDEN;
  about?: string | typeof HIDDEN;
  welcomeNote?: string | typeof HIDDEN;
  pastorNote?: string | typeof HIDDEN;
  // Hero image — a FilesManager file reference (id or URL), not bytes.
  heroImage?: string | typeof HIDDEN;
  // Whole-list-replaced arrays.
  serviceTimes?: ServiceTime[] | typeof HIDDEN;
  // Named social slots.
  facebookUrl?: string | typeof HIDDEN;
  instagramUrl?: string | typeof HIDDEN;
  youtubeUrl?: string | typeof HIDDEN;
  givingUrl?: string | typeof HIDDEN;
  // Sermon source: a YouTube channel id/handle the media page reads.
  sermonYoutubeChannel?: string | typeof HIDDEN;
  // Open list of extra labelled links (whole-list-replaced).
  extraLinks?: ExtraLink[] | typeof HIDDEN;
}

// Blank value for a hidden field: [] for list fields, "" for everything else.
const LIST_FIELDS: ReadonlyArray<keyof CampusContentFields> = ["serviceTimes", "extraLinks"];
const blankFor = (field: keyof CampusContentFields): any => (LIST_FIELDS.includes(field) ? [] : "");

// Resolve one campus's rendered content from the org default + that campus's
// SPARSE override, field by field. Pass an empty/undefined override for a campus
// with no overrides (→ pure org default), or an empty/undefined orgDefault for a
// church that has only campus content.
export function resolveForCampus(
  orgDefault: CampusContentFields | null | undefined,
  campusOverride: CampusContentFields | null | undefined
): CampusContentFields {
  const org = orgDefault ?? {};
  const override = campusOverride ?? {};
  const resolved: CampusContentFields = {};

  // The union of every field either side declares — so an override-only or
  // default-only field still resolves.
  const fields = new Set<keyof CampusContentFields>([
    ...(Object.keys(org) as (keyof CampusContentFields)[]),
    ...(Object.keys(override) as (keyof CampusContentFields)[])
  ]);

  for (const field of fields) {
    const ov = override[field];
    if (ov === undefined) {
      // ABSENT on the override → inherit the org default (live propagation).
      (resolved as any)[field] = org[field];
    } else if (ov === HIDDEN) {
      // EXPLICIT hide → resolved BLANK even though the org default may be set.
      (resolved as any)[field] = blankFor(field);
    } else {
      // Non-empty override (incl. a whole replacement list) → the campus value.
      (resolved as any)[field] = ov;
    }
  }

  return resolved;
}
