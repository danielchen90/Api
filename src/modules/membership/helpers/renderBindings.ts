// renderBindings.ts — server-side port of the B1Admin editor's binding resolution.
//
// KEEP IN SYNC WITH forks/B1Admin/src/licenseTemplates/helpers/bindings.ts.
// `resolveBinding` + `formatCampusAddress` are ported VERBATIM (same dayjs date
// formats, same "" on missing so the caller applies element.fallback) so the printed
// card resolves bindings byte-identically to the editor preview. Any divergence here
// = preview ≠ print, which the phase's fidelity constraint forbids.
//
// `buildPreviewData` is the server counterpart of the editor's real-person preview
// (BINDING_REAL_PATHS): it flattens a fetched (person, ordination, ordinationType,
// campus, church) tuple into the SAME flat Record<string,string> keyed by binding key
// that `resolveBinding` consumes.

import dayjs from "dayjs";

// --- resolveBinding (ported verbatim from the editor) --------------------------

// Date binding keys — must match the isDate flags in the editor's BINDING_CATALOG.
const DATE_KEYS = new Set<string>(["ordination.grantedDate", "ordination.expirationDate"]);

const isDateKey = (key: string): boolean => DATE_KEYS.has(key);

// Resolve a binding key against a flat data map. Date keys format via dayjs with the
// element's dateFormat (default "MMM D, YYYY"). Returns "" when missing — the caller
// applies element.fallback.
export const resolveBinding = (
  key: string,
  data: Record<string, any>,
  dateFormat?: string
): string => {
  const value = data?.[key];
  if (value === undefined || value === null || value === "") return "";
  if (isDateKey(key)) {
    const d = dayjs(value);
    return d.isValid() ? d.format(dateFormat || "MMM D, YYYY") : "";
  }
  return String(value);
};

// --- formatCampusAddress (ported verbatim from the editor) ---------------------

export interface CampusAddressParts {
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
}

// Format a campus's address parts into ONE gracefully-wrapping field: street line(s)
// then "City, State ZIP" on the next line. Empty parts are dropped. Single source of
// truth shared with the editor's real-person preview.
export const formatCampusAddress = (c?: CampusAddressParts): string => {
  if (!c) return "";
  const street = [c.address1, c.address2].filter(Boolean).join(", ");
  const cityLine = [[c.city, c.state].filter(Boolean).join(", "), c.zip].filter(Boolean).join(" ");
  return [street, cityLine].filter(Boolean).join("\n");
};

// --- buildPreviewData ----------------------------------------------------------

// Structural input shapes (kept minimal + decoupled from the ORM models so this stays
// a pure, testable function — the 06-04 controller passes in the fetched rows).
export interface BindablePersonName {
  first?: string;
  middle?: string;
  last?: string;
  display?: string;
}
export interface BindablePerson {
  name?: BindablePersonName;
}
export interface BindableOrdination {
  status?: string;
  credentialNumber?: string;
  grantedDate?: Date | string | null;
  expirationDate?: Date | string | null;
}
export interface BindableOrdinationType {
  name?: string;
  code?: string;
}
export interface BindableCampus extends CampusAddressParts {
  name?: string;
}
export interface BindableChurch {
  name?: string;
}

// Coerce a Date|string|null date into a resolveBinding-friendly, timezone-STABLE value:
// a date-only "YYYY-MM-DD" string derived from the source's UTC calendar components.
// grantedDate/expirationDate are calendar dates (no meaningful time-of-day); emitting a
// full UTC ISO timestamp would let resolveBinding's local-timezone dayjs().format() shift
// it by a day on servers behind/ahead of UTC. A bare "YYYY-MM-DD" is parsed by dayjs as
// LOCAL midnight, so it formats to the same calendar day on any server TZ. Returns "" when
// absent — resolveBinding then yields "" and the caller applies element.fallback.
const isoDate = (d?: Date | string | null): string => {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return "";
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Flatten a fetched (person, ordination, ordinationType, campus, church) tuple into the
// flat binding map. Mirrors BINDING_REAL_PATHS: person.* comes off the Name object,
// campus.address is COMPUTED via formatCampusAddress, dates are passed through as ISO
// strings for resolveBinding to format. Missing pieces yield "" (caller applies fallback).
export const buildPreviewData = (
  person?: BindablePerson,
  ordination?: BindableOrdination,
  ordinationType?: BindableOrdinationType,
  campus?: BindableCampus,
  church?: BindableChurch
): Record<string, string> => {
  const first = person?.name?.first ?? "";
  const last = person?.name?.last ?? "";
  const fullName = [first, last].filter(Boolean).join(" ");
  return {
    // person
    "person.fullName": fullName,
    "person.lastName": last,
    "person.firstName": first,
    "person.displayName": person?.name?.display ?? "",
    "person.middleName": person?.name?.middle ?? "",
    // ordination type
    "ordinationType.name": ordinationType?.name ?? "",
    "ordinationType.code": ordinationType?.code ?? "",
    // campus
    "campus.name": campus?.name ?? "",
    "campus.address": formatCampusAddress(campus),
    "campus.city": campus?.city ?? "",
    "campus.state": campus?.state ?? "",
    // credential / ordination
    "credentialNumber": ordination?.credentialNumber ?? "",
    "ordination.grantedDate": isoDate(ordination?.grantedDate),
    "ordination.expirationDate": isoDate(ordination?.expirationDate),
    "ordination.status": ordination?.status ?? "",
    // church
    "church.name": church?.name ?? "",
  };
};
