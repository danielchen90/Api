import { PersonHelper } from "./PersonHelper.js";

/**
 * PublicDto — THE `/public/` redacting-DTO convention for ANONYMOUS surfaces.
 *
 * This is the FOUNDATIONAL data-safety gate for the public website (PUB-01). Every
 * anonymous read — the leadership list here, the Plan-05 content read, and all of
 * Phase 20 — MUST project through a builder in this file. It exists so that a
 * public visitor can NEVER see member PII (email / phone / address / householdId /
 * birthDate) and NEVER a minor's photo.
 *
 * WHY POSITIVE-WHITELIST (do NOT copy the subtractive redaction elsewhere in the repo):
 *   `PersonRepo.convertToPreferenceModel` / `convertToBasicModel` build a full Person
 *   and then rely on remembering to null every private field — they STILL carry a
 *   `contactInfo` object. That is a subtractive approach: add a new private column to
 *   `people` and it silently leaks through anything built that way.
 *
 *   The builders here construct a FRESH object referencing ONLY whitelisted keys. A
 *   new column on `people` can never leak, because no PII key is ever named. This is
 *   the single most important invariant in this file:
 *
 *   >>> NEVER add a `contactInfo`, `email`, `phoneNumber`, `address`, `householdId`,
 *   >>> or `birthDate` key to any builder here. If a future public surface needs a
 *   >>> new field, add it to an explicit whitelist type + builder — never widen a
 *   >>> projection by spreading a raw row.
 *
 * Phase 20 EXTENDS this file with additional `toPublic*` builders (campus, media,
 * etc.) — all following the same fresh-object, named-keys-only pattern.
 */

/** The ONLY shape an anonymous leadership read ever returns. */
export type PublicLeaderDTO = {
  id: string;
  displayName: string;
  role: string | null;
  photo: string | null;
};

/** Age in whole years from a birthDate; null when birthDate is missing/unparseable. */
function ageFromBirthDate(birthDate: any): number | null {
  if (!birthDate) return null;
  const dob = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

/**
 * Resolve the public photo for a row — ADULTS ONLY.
 *
 * RESEARCH Pitfall 4: no photo-consent column exists. This phase suppresses ALL minor
 * photos and treats an adult's positive leadership opt-in as satisfying photo consent.
 * The gate is deliberately CONSERVATIVE: a missing/unknown birthDate suppresses the
 * photo (we cannot prove the person is an adult), and under-18 always suppresses it.
 *
 * Returns a non-empty photo path for an adult with a stored photo, otherwise null.
 */
export function resolvePublicPhoto(row: any): string | null {
  const age = ageFromBirthDate(row?.birthDate);
  if (age === null || age < 18) return null; // unknown age or minor → never a photo
  const path = PersonHelper.getPhotoPath(row?.churchId, { id: row?.id, photoUpdated: row?.photoUpdated } as any);
  return path && path.length > 0 ? path : null;
}

/**
 * Project a loaded leader row into the ONLY anonymous-safe shape.
 *
 * References ONLY id, a display name, a role/title, and an adult-gated photo. It does
 * NOT reference email, phone, contactInfo, address, householdId, or birthDate — so
 * those can never leak, no matter what columns the row carries.
 *
 * `row.role` (or `row.roleName`) is the leadership title; when absent, role is null.
 */
export function toPublicLeader(row: any): PublicLeaderDTO {
  return {
    id: row?.id ?? null,
    displayName: row?.displayName ?? row?.name?.display ?? "",
    role: row?.role ?? row?.roleName ?? null,
    photo: resolvePublicPhoto(row)
  };
}

/**
 * Generic positive projector: build a fresh object from ONLY the listed keys.
 *
 * For Plan 05 / Phase 20 reuse when projecting a whitelisted subset of a content row.
 * Because it copies only the named keys into a fresh object, an un-listed (e.g. newly
 * added private) column can never pass through.
 */
export function pickWhitelist<T>(row: any, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  if (!row) return out;
  for (const key of keys) {
    out[key] = row[key as string];
  }
  return out;
}
