import { AuthenticatedUser } from "@churchapps/apihelper";
import { Repos } from "../repositories/index.js";
import { CAMPUS_ORGWIDE_MARKER } from "./campusRoles.js";

// Closed union (fail-closed): all / a NON-EMPTY scoped set / deny.
export type AuxiliaryScope =
  | { mode: "all" }
  | { mode: "scoped"; auxiliaryIds: string[] }
  | { mode: "deny" };

/**
 * Per-request auxiliary-scope resolver — mirrors CampusScopeHelper.
 *
 * Org-wide roles (Leadership Admin, Reporter) carry CAMPUS_ORGWIDE_MARKER and see
 * every auxiliary. Otherwise the set comes from persisted userAuxiliaries
 * assignments (an "Auxiliary President"). Zero assignments → deny (never an empty
 * IN ()). Scope is derived server-side only; never from the request.
 */
export class AuxiliaryScopeHelper {
  static async resolve(au: AuthenticatedUser, repos: Repos): Promise<AuxiliaryScope> {
    if (au.checkAccess(CAMPUS_ORGWIDE_MARKER)) return { mode: "all" };
    const auxiliaryIds = await repos.userAuxiliary.loadAuxiliaryIdsForUser(au.churchId, au.id);
    if (!auxiliaryIds.length) return { mode: "deny" };
    return { mode: "scoped", auxiliaryIds };
  }

  // May the caller read this auxiliary? (all, or it's in their scoped set.)
  static canRead(scope: AuxiliaryScope, auxiliaryId: string): boolean {
    if (scope.mode === "all") return true;
    if (scope.mode === "deny") return false;
    return scope.auxiliaryIds.includes(auxiliaryId);
  }
}
