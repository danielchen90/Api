// reportGrouping.ts — the PURE, framework-free filter + group mirror for the leadership
// leadership-roster report (RPT-01..05).
//
// WHY IT IS FRAMEWORK-FREE: the 08-03 parity harness imports this module STANDALONE (no
// headless-browser / DI / HTTP layer dragged in) to prove the PDF grouping cannot drift from
// the on-screen grouping. Only type-only imports are permitted here (they erase at compile).
//
// The SHARED GROUPING CONTRACT block below (STATUS_ORDER + dedupeKey + compareRows) is authored
// to be BYTE-IDENTICAL with the client copy in
// forks/B1Admin/src/ordinations/reports/reportHelpers.ts (Plan 08-02). 08-03 diffs the extracted
// region character-for-character AND runs a fixture equivalence harness — a single byte of drift
// fails the phase. Do NOT edit anything between the START and END marker lines.

// ===== SHARED GROUPING CONTRACT (RPT-05 parity) START =====
export const STATUS_ORDER = ["pending", "active", "suspended", "emeritus", "revoked"] as const;

export type GroupDim = "location" | "type" | "status";

export function dedupeKey(
  row: { personId: string; campusId: string; ordinationTypeId: string; status: string },
  dims: GroupDim[]
): string {
  const parts = dims.map((dim) => {
    if (dim === "location") return row.personId + "|" + row.campusId;
    if (dim === "type") return row.personId + "|" + row.ordinationTypeId;
    return row.personId + "|" + row.status;
  });
  return parts.join("|");
}

export function compareRows(
  a: { firstName: string; lastName: string; displayName: string },
  b: { firstName: string; lastName: string; displayName: string },
  sortBy: "lastName" | "firstName",
  sortDir: "asc" | "desc"
): number {
  const primaryField = sortBy === "lastName" ? "lastName" : "firstName";
  const otherField = sortBy === "lastName" ? "firstName" : "lastName";
  const dir = sortDir === "desc" ? -1 : 1;
  const primary = a[primaryField].localeCompare(b[primaryField], undefined, { sensitivity: "base" });
  if (primary !== 0) return primary * dir;
  const other = a[otherField].localeCompare(b[otherField], undefined, { sensitivity: "base" });
  if (other !== 0) return other;
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
}
// ===== SHARED GROUPING CONTRACT (RPT-05 parity) END =====

// ---------------------------------------------------------------------------
// Contracts (mirror the ReportFilterSpec JSON body — SHARED with Plan 08-02)
// ---------------------------------------------------------------------------

export type GroupOption = "none" | GroupDim;

// The request body the endpoint parses and the client posts. Defensive defaults are applied
// by normalizeSpec below so a partial body never throws.
export interface ReportFilterSpec {
  campusIds: string[];           // display filter WITHIN scope; [] = no campus narrowing
  ordinationTypeIds: string[];   // [] = all types
  statuses: string[];            // subset of STATUS_ORDER; [] = all statuses
  expiringWithinDays: number | null; // null = no expiration filter
  search: string;                // free-text over "first last credentialNumber"; "" = no search
  groupBy1: GroupOption;         // primary grouping ("none" = flat)
  groupBy2: GroupOption;         // secondary/nested grouping ("none" = single-level)
  sortBy: "lastName" | "firstName";
  sortDir: "asc" | "desc";
}

// The per-credential atomic row the filter/group operate over. Exposes EXACTLY the shared
// field names the contract block references (personId, campusId, ordinationTypeId, status,
// firstName, lastName, displayName) plus the report-only display columns.
export interface ReportRow {
  personId: string;
  campusId: string;
  ordinationTypeId: string;
  status: string;
  firstName: string;
  lastName: string;
  displayName: string;
  credentialNumber: string;
  grantedDate: string;    // "YYYY-MM-DD" or "" when absent
  expirationDate: string; // "YYYY-MM-DD" or "" when absent
}

// Structural (type-only) inputs — kept minimal so no model class is imported.
export interface OrdinationLike {
  personId: string;
  campusId?: string | null;
  ordinationTypeId?: string | null;
  status?: string | null;
  credentialNumber?: string | null;
  grantedDate?: Date | string | null;
  expirationDate?: Date | string | null;
}
export interface NameLabel { firstName: string; lastName: string; displayName: string; }
export interface TypeLabel { name: string; sortOrder: number; }
export interface CampusLabel { name: string; }

// ---------------------------------------------------------------------------
// Grouped model (the serializable shape the PDF AND the parity harness consume)
// ---------------------------------------------------------------------------

export interface GroupedModelRow {
  personId: string;
  name: string;
  campusName: string;
  typeName: string;
  status: string;
  credentialNumber: string;
  grantedDate: string;
  expirationDate: string;
}

export interface GroupNode {
  label: string;
  personCount: number;      // DISTINCT persons in this (sub)group
  rows: GroupedModelRow[];  // leaf rows (empty when subGroups is populated)
  subGroups: GroupNode[];   // nested groups (empty at a leaf)
}

export interface GroupedModel {
  groups: GroupNode[];
  totalPeople: number;
}

// ---------------------------------------------------------------------------
// Pure utilities
// ---------------------------------------------------------------------------

// Coerce a Date|string|null calendar date into a timezone-STABLE "YYYY-MM-DD" (or "" when
// absent). Mirrors renderBindings.isoDate: DATE columns come back as a UTC-midnight Date, so
// deriving from UTC components avoids the local-offset off-by-one (Pitfall 4). A bare
// "YYYY-MM-DD" string is passed through by slice.
const isoDateOnly = (d?: Date | string | null): string => {
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 10);
  if (isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Parse a "YYYY-MM-DD" as LOCAL midnight (new Date(y, m-1, d)). AVOID new Date("YYYY-MM-DD")
// which parses as UTC and shifts a day in negative offsets (Pitfall 4).
const parseLocalDay = (s: string): Date | null => {
  const parts = (s || "").slice(0, 10).split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
};

const startOfLocalToday = (): Date => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};

const distinctPeople = (rows: ReportRow[]): number => new Set(rows.map((r) => r.personId)).size;

const activeDimsOf = (spec: ReportFilterSpec): GroupDim[] =>
  [spec.groupBy1, spec.groupBy2].filter((g): g is GroupDim => g !== "none");

// ---------------------------------------------------------------------------
// Row construction + defensive spec parsing
// ---------------------------------------------------------------------------

// Map scoped ordination records + a personId→name lookup into per-credential ReportRows.
export function buildReportRows(
  ordinations: OrdinationLike[],
  namesById: Record<string, NameLabel>
): ReportRow[] {
  return ordinations.map((o) => {
    const nm = namesById[o.personId] || { firstName: "", lastName: "", displayName: "" };
    return {
      personId: o.personId,
      campusId: o.campusId || "",
      ordinationTypeId: o.ordinationTypeId || "",
      status: o.status || "",
      firstName: nm.firstName || "",
      lastName: nm.lastName || "",
      displayName: nm.displayName || "",
      credentialNumber: o.credentialNumber || "",
      grantedDate: isoDateOnly(o.grantedDate),
      expirationDate: isoDateOnly(o.expirationDate)
    };
  });
}

const GROUP_OPTIONS: GroupOption[] = ["none", "location", "type", "status"];

// Apply defensive defaults so a partial/absent body never throws.
export function normalizeSpec(body: any): ReportFilterSpec {
  const b = body || {};
  const asOption = (v: any): GroupOption => (GROUP_OPTIONS.indexOf(v) > -1 ? v : "none");
  const days = b.expiringWithinDays;
  return {
    campusIds: Array.isArray(b.campusIds) ? b.campusIds : [],
    ordinationTypeIds: Array.isArray(b.ordinationTypeIds) ? b.ordinationTypeIds : [],
    statuses: Array.isArray(b.statuses) ? b.statuses : [],
    expiringWithinDays: typeof days === "number" && !isNaN(days) ? days : null,
    search: typeof b.search === "string" ? b.search : "",
    groupBy1: asOption(b.groupBy1),
    groupBy2: asOption(b.groupBy2),
    sortBy: b.sortBy === "firstName" ? "firstName" : "lastName",
    sortDir: b.sortDir === "desc" ? "desc" : "asc"
  };
}

// ---------------------------------------------------------------------------
// filterRows — mirror of the client filterReport (RESEARCH Pattern 3)
// ---------------------------------------------------------------------------

export function filterRows(rows: ReportRow[], spec: ReportFilterSpec): ReportRow[] {
  const campusSet = spec.campusIds.length ? new Set(spec.campusIds) : null;
  const typeSet = spec.ordinationTypeIds.length ? new Set(spec.ordinationTypeIds) : null;
  const statusSet = spec.statuses.length ? new Set(spec.statuses) : null;
  const q = (spec.search || "").trim().toLowerCase();

  let expStart: Date | null = null;
  let expEnd: Date | null = null;
  if (spec.expiringWithinDays !== null) {
    expStart = startOfLocalToday();
    expEnd = new Date(expStart.getFullYear(), expStart.getMonth(), expStart.getDate() + spec.expiringWithinDays);
  }

  return rows.filter((r) => {
    if (campusSet && !campusSet.has(r.campusId)) return false;
    if (typeSet && !typeSet.has(r.ordinationTypeId)) return false;
    if (statusSet && !statusSet.has(r.status)) return false;

    if (expStart && expEnd) {
      const exp = parseLocalDay(r.expirationDate); // null expirationDate excluded
      if (!exp) return false;
      if (exp < expStart || exp > expEnd) return false;
    }

    if (q) {
      const hay = `${r.firstName} ${r.lastName} ${r.credentialNumber || ""}`.toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// buildGroupedModel — nested 2-level grouping (RPT-01)
// ---------------------------------------------------------------------------

const bucketKeyForDim = (dim: GroupDim, row: ReportRow): string =>
  dim === "location" ? row.campusId : dim === "type" ? row.ordinationTypeId : row.status;

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  active: "Active",
  suspended: "Suspended",
  emeritus: "Emeritus",
  revoked: "Revoked"
};

const dimLabel = (
  dim: GroupDim,
  key: string,
  types: Record<string, TypeLabel>,
  campuses: Record<string, CampusLabel>
): string => {
  if (dim === "location") return campuses[key]?.name || "Unassigned";
  if (dim === "type") return types[key]?.name || "Unassigned";
  return STATUS_LABELS[key] || key || "Unassigned";
};

// Order value for a bucket: location A–Z by name; type by sortOrder (seniority); status by
// STATUS_ORDER. Returned as {ord, label} so the caller sorts uniformly per dim.
const dimOrder = (
  dim: GroupDim,
  key: string,
  types: Record<string, TypeLabel>
): number => {
  if (dim === "type") return types[key]?.sortOrder ?? 999;
  if (dim === "status") return (STATUS_ORDER as readonly string[]).indexOf(key);
  return 0; // location ordered by label
};

// Sort + dedupe leaf rows by the union of the group's active dims (empty dims = atomic, no dedupe).
const dedupeAndSort = (rows: ReportRow[], dims: GroupDim[], spec: ReportFilterSpec): ReportRow[] => {
  const sorted = [...rows].sort((a, b) => compareRows(a, b, spec.sortBy, spec.sortDir));
  if (!dims.length) return sorted;
  const seen = new Set<string>();
  const out: ReportRow[] = [];
  for (const r of sorted) {
    const k = dedupeKey(r, dims);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
};

const toModelRow = (
  r: ReportRow,
  names: Record<string, NameLabel>,
  types: Record<string, TypeLabel>,
  campuses: Record<string, CampusLabel>
): GroupedModelRow => ({
  personId: r.personId,
  name: names[r.personId]?.displayName || r.displayName || `${r.lastName}, ${r.firstName}`.trim(),
  campusName: campuses[r.campusId]?.name || "Unassigned",
  typeName: types[r.ordinationTypeId]?.name || "Unassigned",
  status: STATUS_LABELS[r.status] || r.status,
  credentialNumber: r.credentialNumber,
  grantedDate: r.grantedDate,
  expirationDate: r.expirationDate
});

// Recursively build one grouping level. `dims` is the full active-dim list; `dimIndex` the
// current level. Leaf rows dedupe by the FULL `dims` union (contract). Buckets are ordered per
// the current dim; rows within a leaf are ordered via compareRows.
const buildLevel = (
  rows: ReportRow[],
  dims: GroupDim[],
  dimIndex: number,
  names: Record<string, NameLabel>,
  types: Record<string, TypeLabel>,
  campuses: Record<string, CampusLabel>,
  spec: ReportFilterSpec
): GroupNode[] => {
  const dim = dims[dimIndex];
  const buckets = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const key = bucketKeyForDim(dim, r);
    const arr = buckets.get(key);
    if (arr) arr.push(r);
    else buckets.set(key, [r]);
  }

  const entries: { node: GroupNode; ord: number; label: string }[] = [];
  for (const [key, groupRows] of buckets) {
    const label = dimLabel(dim, key, types, campuses);
    const ord = dimOrder(dim, key, types);
    let node: GroupNode;
    if (dimIndex < dims.length - 1) {
      const subGroups = buildLevel(groupRows, dims, dimIndex + 1, names, types, campuses, spec);
      node = { label, personCount: distinctPeople(groupRows), rows: [], subGroups };
    } else {
      const leaf = dedupeAndSort(groupRows, dims, spec);
      node = {
        label,
        personCount: distinctPeople(leaf),
        rows: leaf.map((r) => toModelRow(r, names, types, campuses)),
        subGroups: []
      };
    }
    entries.push({ node, ord, label });
  }

  entries.sort((a, b) => {
    if (dim === "location") return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    if (dim === "status") return a.ord - b.ord;
    return a.ord - b.ord || a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
  return entries.map((e) => e.node);
};

export function buildGroupedModel(
  rows: ReportRow[],
  names: Record<string, NameLabel>,
  types: Record<string, TypeLabel>,
  campuses: Record<string, CampusLabel>,
  spec: ReportFilterSpec
): GroupedModel {
  const filtered = filterRows(rows, spec);
  const dims = activeDimsOf(spec);

  if (!dims.length) {
    // Flat roster: per-credential atomic rows (zero active dims ⇒ no dedupe), single group.
    const leaf = dedupeAndSort(filtered, dims, spec);
    return {
      groups: [
        {
          label: "All Ministers",
          personCount: distinctPeople(leaf),
          rows: leaf.map((r) => toModelRow(r, names, types, campuses)),
          subGroups: []
        }
      ],
      totalPeople: distinctPeople(filtered)
    };
  }

  return {
    groups: buildLevel(filtered, dims, 0, names, types, campuses, spec),
    totalPeople: distinctPeople(filtered)
  };
}
