import { AuthenticatedUser } from "@churchapps/apihelper";
import { Repos } from "../repositories/index.js";
import { CampusScope } from "./applyCampusScope.js";
import { CAMPUS_ORGWIDE_MARKER } from "./campusRoles.js";

/**
 * Per-request campus-scope resolver (PERM-02 — server-side derivation).
 *
 * `resolve` derives the caller's `CampusScope` ENTIRELY server-side from two trusted inputs:
 *   1. `au` — the authenticated session. The org-wide marker (CAMPUS_ORGWIDE_MARKER) rides in
 *      the JWT permission list; `au.checkAccess(marker)` short-circuits to `mode:"all"`.
 *   2. `repos.userCampus` — the persisted assignment set, keyed on `au.id` + `au.churchId`.
 *
 * It NEVER reads `req.body` / `req.query` — a client cannot assert or widen its own scope
 * (Pitfall 3). No JWT claim is added and no upstream auth file is edited: scope is recomputed
 * per request from the seeded marker + persisted assignments (RESEARCH Session/Token Shape).
 *
 * "Wider wins" for multi-role users is automatic: ANY role carrying the marker returns
 * `mode:"all"` before the assignment lookup ever runs.
 */
export class CampusScopeHelper {
  static async resolve(au: AuthenticatedUser, repos: Repos): Promise<CampusScope> {
    // Org-wide roles (Leadership Admin, Reporter) carry the marker → see every campus (PERM-03/05).
    if (au.checkAccess(CAMPUS_ORGWIDE_MARKER)) return { mode: "all" };

    // Campus-scoped roles: the set is derived from persisted assignments, never the request.
    const campusIds = await repos.userCampus.loadCampusIdsForUser(au.churchId, au.id);

    // Fail closed (Pitfall 2): zero assignments → deny, NEVER an empty IN ().
    if (!campusIds.length) return { mode: "deny" };

    // Scoped to exactly the user's assigned campuses (PERM-04).
    return { mode: "scoped", campusIds };
  }
}
