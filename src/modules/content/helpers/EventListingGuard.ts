import { toBool } from "./PublicEventFeed.js";

/**
 * EventListingGuard: write-side rules for the public-website listing fields on events
 * (publicListing, campusId, location, registrationUrl, image). Pure and DB-free.
 *
 * Scope semantics mirror the membership campus-scoping layer (CampusScopeHelper +
 * assertWritableCampus): the scope is resolved server-side (membership gateway, from the DB) and
 *   - "all"    may publish to any center or network-wide (campusId null);
 *   - "scoped" may publish ONLY to its own centers, never network-wide;
 *   - "deny"   may not publish at all.
 * The same rule protects an event that is ALREADY listed: a campus-B admin can neither unpublish
 * nor re-home a campus-A listing.
 */
export type ListingScope = { mode: "all" } | { mode: "scoped"; campusIds: string[] } | { mode: "deny" };

export const LISTING_LIMITS = { location: 255, registrationUrl: 500, image: 500 };

const LISTING_KEYS = ["publicListing", "campusId", "location", "registrationUrl", "image"] as const;

function canWriteTarget(scope: ListingScope, campusId: string | null): boolean {
  if (scope.mode === "all") return true;
  if (scope.mode === "deny") return false;
  return !!campusId && scope.campusIds.includes(campusId);
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Clean + validate the listing fields in place. Returns readable errors (empty when valid). */
export function validateListingFields(ev: any, validCampusIds: string[]): string[] {
  const errors: string[] = [];
  if (ev.publicListing !== undefined) ev.publicListing = toBool(ev.publicListing);
  if (ev.campusId !== undefined) {
    ev.campusId = ev.campusId ? ev.campusId.toString().trim() : null;
    if (ev.campusId && !validCampusIds.includes(ev.campusId)) errors.push("Unknown worship center.");
  }
  for (const key of ["location", "registrationUrl", "image"] as const) {
    if (ev[key] === undefined) continue;
    if (ev[key] === null || ev[key] === "") { ev[key] = null; continue; }
    if (typeof ev[key] !== "string") { errors.push(`${key} must be text.`); continue; }
    const t = ev[key].trim();
    ev[key] = t || null;
    if (t.length > LISTING_LIMITS[key]) errors.push(`${key} can be at most ${LISTING_LIMITS[key]} characters.`);
    if (t && key !== "location" && !isHttpUrl(t)) errors.push(key === "registrationUrl" ? "Registration link must start with http:// or https://" : "Image link must start with http:// or https://");
  }
  return errors;
}

const norm = (k: string, v: any) => (k === "publicListing" ? toBool(v) : (v === undefined || v === null || v === "" ? null : v.toString()));

/** Listing keys whose incoming value differs from the stored one (all defined keys for a new event). */
export function changedListingKeys(incoming: any, existing: any | null): string[] {
  return LISTING_KEYS.filter((k) => {
    if (incoming?.[k] === undefined) return false;
    if (!existing) return k === "publicListing" ? toBool(incoming[k]) : norm(k, incoming[k]) !== null;
    return norm(k, incoming[k]) !== norm(k, existing[k]);
  });
}

/**
 * May this caller save `incoming` over `existing` (null for a new event)? Re-sending unchanged
 * listing values (a client that round-trips the whole row) is not a listing change, so a group
 * leader can still edit the title of an event an admin published.
 */
export function canWriteListing(scope: ListingScope, incoming: any, existing: any | null): boolean {
  const changed = changedListingKeys(incoming, existing);
  if (changed.length === 0) return true;
  const wasListed = existing ? toBool(existing.publicListing) : false;
  const existingCampus: string | null = existing?.campusId || null;
  const willList = incoming.publicListing !== undefined ? toBool(incoming.publicListing) : wasListed;
  const newCampus: string | null = incoming.campusId !== undefined ? (incoming.campusId || null) : existingCampus;

  // Changing (or removing) an existing listing requires rights over where it lives now.
  if (wasListed && !canWriteTarget(scope, existingCampus)) return false;
  // Publishing (or changing a published event) requires rights over the target center.
  if (willList && !canWriteTarget(scope, newCampus)) return false;
  // Draft listing values on an unpublished event (e.g. picking a center before publishing) still
  // need a usable scope so a deny-scope caller cannot pre-stage a listing.
  if (!willList && !wasListed && scope.mode === "deny") return false;
  return true;
}
