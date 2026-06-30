import { sql } from "kysely";

/**
 * Campus-scope enforcement PRIMITIVES (PERM-02 / PERM-06).
 *
 * These are PURE: they depend only on a resolved `CampusScope` value and a Kysely query
 * builder. They take NO `au`, repos, or request — so they unit-test without a DB (the gate
 * suite in Plan 05 calls them directly). The per-request scope is derived server-side by
 * `CampusScopeHelper.resolve` (CampusScopeHelper.ts), NEVER from the request body.
 *
 * FAIL-CLOSED IS STRUCTURAL (Pitfall 2): `CampusScope` is a CLOSED union whose only states are
 * `all`, a NON-EMPTY `scoped` set, or `deny`. An empty assignment list becomes `deny` upstream
 * (in the resolver) and `deny` emits `sql`1=0`` — so an empty list can never degrade into an
 * empty `IN ()` that would silently leak every row.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * CANONICAL NET-NEW SCOPED-REPO USAGE (copy verbatim in Phases 2/6/7).
 *
 * `applyCampusScope` is ADDITIVE to the mandatory churchId tenancy filter — it NEVER replaces
 * it (Pitfall 5). Always filter churchId FIRST, then layer the campus scope on top.
 *
 *   // Scoped repo method — list:
 *   async loadAll(churchId: string, scope: CampusScope) {
 *     let q = getDb().selectFrom("things").selectAll().where("churchId", "=", churchId);
 *     q = applyCampusScope(q, scope);            // adds nothing for "all", IN(set) for "scoped", 1=0 for "deny"
 *     return (await q.execute()).map((r) => this.rowToModel(r));
 *   }
 *
 *   // Scoped repo method — get-by-id (404-hide cross-campus rows: return `?? {}`):
 *   async load(churchId: string, id: string, scope: CampusScope) {
 *     let q = getDb().selectFrom("things").selectAll()
 *       .where("churchId", "=", churchId).where("id", "=", id);
 *     q = applyCampusScope(q, scope);
 *     return (await q.executeTakeFirst()) ?? {}; // out-of-scope id is indistinguishable from "not found"
 *   }
 *
 *   // Scoped controller WRITE action (validate the target campus before persisting):
 *   const scope = await CampusScopeHelper.resolve(au, this.repos);
 *   if (!assertWritableCampus(scope, item.campusId)) return this.json({}, 401); // client cannot widen
 *
 * For a JOINed query whose campus column is aliased/qualified, pass the `column` argument
 * (e.g. `applyCampusScope(q, scope, "people.campusId")`).
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
export type CampusScope =
  | { mode: "all" }
  | { mode: "scoped"; campusIds: string[] } // invariant: campusIds is NON-EMPTY (else use "deny")
  | { mode: "deny" };

/**
 * Apply a resolved campus scope to a Kysely query builder.
 *
 * - `all`    → returns `qb` UNCHANGED (org-wide; no campus filter added).
 * - `deny`   → `qb.where(sql`1=0`)` — structural fail-closed; matches zero rows (never `IN ()`).
 * - `scoped` → `qb.where(column, "in", campusIds)` over the user's NON-EMPTY assigned set.
 *
 * Generic over the builder type so it composes with any select/update/delete builder; the
 * concrete Kysely type is preserved in/out. NEVER branch straight from a `campusIds[]` to an
 * `IN` here — an empty list must already have become `deny` in the resolver (Pitfall 2).
 */
export function applyCampusScope<QB>(qb: QB, scope: CampusScope, column = "campusId"): QB {
  switch (scope.mode) {
    case "all":
      return qb;
    case "deny":
      return (qb as any).where(sql`1=0`) as QB;
    case "scoped":
      return (qb as any).where(column as any, "in", scope.campusIds) as QB;
  }
}

/**
 * Validate that a scope MAY write the given target campus (PERM-06 write side).
 *
 * - `all`    → `!!campusId` (org-wide may write any real campus; rejects empty/falsy targets).
 * - `deny`   → `false` (writes nothing).
 * - `scoped` → `campusIds.includes(campusId)` — a scoped user can ONLY write their own campuses;
 *              a client-supplied campusId outside the set is rejected (cannot widen — Pitfall 3).
 */
export function assertWritableCampus(scope: CampusScope, campusId: string): boolean {
  switch (scope.mode) {
    case "all":
      return !!campusId;
    case "deny":
      return false;
    case "scoped":
      return scope.campusIds.includes(campusId);
  }
}
