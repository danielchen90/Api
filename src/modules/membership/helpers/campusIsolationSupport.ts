import { assertWritableCampus, type CampusScope } from "./applyCampusScope.js";

/**
 * REUSABLE CROSS-CAMPUS ISOLATION TEST SUPPORT (PERM-07).
 *
 * This module is the single registration point for the phase exit-gate contract. It encodes the
 * campus-isolation invariants ONCE as thin, generic assertion helpers wrapped around the scope
 * primitives (`applyCampusScope` / `assertWritableCampus` / `CampusScopeHelper.resolve`). Later
 * phases extend the gate by calling `expectCampusIsolation(myEndpointLoadFn, {...})` with ONE line
 * per new scoped endpoint type — they never re-derive the denial rules.
 *
 * IMPORTANT: this file lives directly in `helpers/` (NOT under `__tests__/`) and is NOT named
 * `*.test.ts`/`*.spec.ts`. Jest `testMatch` is `**\/__tests__\/**\/*.ts` + `**\/?(*.)+(spec|test).ts`;
 * a bare `.ts` under `__tests__` with no `it()` would FAIL the run as an empty suite. This file is
 * imported BY the gate suite, it is never executed as a suite itself. It uses the jest `expect`
 * global, which is always defined in the importing test's runtime.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ENDPOINT TYPES LATER PHASES MUST REGISTER (one `expectCampusIsolation(...)` call each):
 *   - get-by-id        (Phase 2 reads)      → kind: "get-by-id"  (out-of-scope id 404-hides → {})
 *   - search / list    (Phase 2 reads)      → kind: "list"       (silent filter to in-scope rows)
 *   - render           (Phase 6 single card)→ kind: "get-by-id"  (cannot render a foreign campus's card)
 *   - batch render     (Phase 7 batch)      → kind: "list"       (batch only spans in-scope rows)
 *   - reissue          (Phase 7 write)      → expectWriteIsolation (foreign campus target rejected)
 *   - void             (Phase 7 write)      → expectWriteIsolation (foreign campus target rejected)
 *   - export           (Phase 6/7 export)   → kind: "list"       (export is scope-filtered)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * Any scoped read endpoint, reduced to its essence: given a resolved scope (and, for get-by-id, an
 * id) it returns whatever the endpoint would return. The harness drives the SAME function under
 * `scoped` / `all` / `deny` scopes and asserts the isolation contract on the results.
 */
export type ScopedLoadFn = (scope: CampusScope, id?: string) => Promise<unknown> | unknown;

export interface CampusIsolationOpts {
  /** A campus the scoped user IS assigned to (campus "A"). */
  inScopeCampusId: string;
  /** A campus the scoped user is NOT assigned to (campus "B"). */
  outOfScopeCampusId: string;
  /** Endpoint shape. "get-by-id" expects a single row / empty object; "list" expects a filtered array. */
  kind: "get-by-id" | "list";
  /** get-by-id only: an id of a row that lives on the in-scope campus. */
  inScopeId?: string;
  /** get-by-id only: an id of a row that lives on the out-of-scope campus. */
  outOfScopeId?: string;
  /** list only: extract a row's campusId so we can prove no out-of-scope rows leaked. Default: `r.campusId`. */
  campusOf?: (row: any) => string;
  /** Override the "no data returned" matcher. Default: null/undefined, `{}`, or `[]`. */
  isEmpty?: (result: any) => boolean;
  /** Override the "data returned" matcher for get-by-id. Default: NOT `isEmpty`. */
  isPresent?: (result: any) => boolean;
}

/** Default 404-hide / silent-filter matcher: a row is "absent" when it is null/undefined, `{}`, or `[]`. */
function defaultIsEmpty(result: any): boolean {
  if (result == null) return true;
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result === "object") return Object.keys(result).length === 0;
  return false;
}

/**
 * READ-side isolation assertion (the reusable gate body).
 *
 * Drives `loadFn` through the three resolved scopes and proves cross-campus denial:
 *
 *   get-by-id:
 *     - scoped[A] → in-scope id present, out-of-scope id 404-hidden (empty).
 *     - all       → both ids present.
 *     - deny      → both ids empty (fail-closed).
 *   list:
 *     - scoped[A] → non-empty, ALL rows on campus A, NO row on campus B (silent filter).
 *     - all       → includes both campus A and campus B rows.
 *     - deny      → empty (fail-closed).
 *
 * Phases 2/6/7 add a new endpoint type by calling this once with their own `loadFn`.
 */
export async function expectCampusIsolation(loadFn: ScopedLoadFn, opts: CampusIsolationOpts): Promise<void> {
  const isEmpty = opts.isEmpty ?? defaultIsEmpty;
  const isPresent = opts.isPresent ?? ((r: any) => !isEmpty(r));
  const A = opts.inScopeCampusId;
  const B = opts.outOfScopeCampusId;

  const scoped: CampusScope = { mode: "scoped", campusIds: [A] };
  const all: CampusScope = { mode: "all" };
  const deny: CampusScope = { mode: "deny" };

  if (opts.kind === "get-by-id") {
    // scoped: own campus visible, foreign campus indistinguishable from "not found" (404-hide).
    expect(isPresent(await loadFn(scoped, opts.inScopeId))).toBe(true);
    expect(isEmpty(await loadFn(scoped, opts.outOfScopeId))).toBe(true);
    // org-wide: both visible.
    expect(isPresent(await loadFn(all, opts.inScopeId))).toBe(true);
    expect(isPresent(await loadFn(all, opts.outOfScopeId))).toBe(true);
    // deny: nothing, ever (fail-closed).
    expect(isEmpty(await loadFn(deny, opts.inScopeId))).toBe(true);
    expect(isEmpty(await loadFn(deny, opts.outOfScopeId))).toBe(true);
    return;
  }

  // list
  const campusOf = opts.campusOf ?? ((r: any) => r.campusId);

  const scopedRows = (await loadFn(scoped)) as any[];
  expect(Array.isArray(scopedRows)).toBe(true);
  expect(scopedRows.length).toBeGreaterThan(0); // the user does see their own campus
  expect(scopedRows.every((r) => campusOf(r) === A)).toBe(true); // only in-scope rows
  expect(scopedRows.some((r) => campusOf(r) === B)).toBe(false); // zero leakage

  const allRows = (await loadFn(all)) as any[];
  expect(allRows.some((r) => campusOf(r) === A)).toBe(true);
  expect(allRows.some((r) => campusOf(r) === B)).toBe(true); // org-wide sees every campus

  expect(isEmpty(await loadFn(deny))).toBe(true); // fail-closed
}

/**
 * WRITE-side isolation assertion (PERM-06 write target validation).
 *
 * For a NON-org-wide scope (scoped or deny), a write/assignment targeting `foreignCampusId` must be
 * rejected — a client cannot widen its own scope (Pitfall 3). For a `scoped` scope this ALSO proves
 * the gate is not blanket-denying: the user's own campus stays writable.
 *
 * Call with a `scoped` or `deny` scope. (`all` legitimately writes any real campus, so it is not an
 * isolation case; assert that separately if needed.)
 */
export function expectWriteIsolation(scope: CampusScope, foreignCampusId: string): void {
  // Foreign campus is never writable under a scoped/deny scope.
  expect(assertWritableCampus(scope, foreignCampusId)).toBe(false);
  // A scoped user CAN still write its own campus (proves the rejection above is targeted, not total).
  if (scope.mode === "scoped") {
    expect(assertWritableCampus(scope, scope.campusIds[0])).toBe(true);
  }
}
