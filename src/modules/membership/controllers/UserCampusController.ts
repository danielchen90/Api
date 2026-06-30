import { controller, httpGet, httpPost, httpDelete, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { CampusScopeHelper, assertWritableCampus, CAMPUS_WRITE_PERMISSION } from "../helpers/index.js";

/**
 * Scope-checked + write-gated assignment API over UserCampusRepo (PERM-01/04/05).
 *
 * Every write (assign, remove) is guarded by TWO independent checks, in order:
 *   1. WRITE-CAPABILITY GATE (PERM-05) — `au.checkAccess(CAMPUS_WRITE_PERMISSION)` (an Edit-level
 *      capability granted ONLY to Leadership Admin + Campus Admin). Read-only Viewer/Reporter fail
 *      this and 401 — even Reporter, which carries the org-wide marker. The marker means org-wide
 *      *scope*, NEVER write capability (Plan 05 Open-Q3: scope `all` does not imply write permission),
 *      so we never gate on CAMPUS_ORGWIDE_MARKER.
 *   2. SCOPE GATE (PERM-04) — `assertWritableCampus(scope, campusId)` against the server-derived
 *      CampusScope. A Campus Admin may only assign/remove within their own assigned campus set; a
 *      client cannot widen via the request body (Pitfall 3). campusId is validated against the
 *      server-derived scope, never trusted directly.
 */
@controller("/userCampuses")
export class UserCampusController extends MembershipBaseController {

  @httpGet("/user/:userId")
  public async listForUser(@requestParam("userId") userId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // Read-only: intentionally NOT gated on CAMPUS_WRITE_PERMISSION. Org-wide read-only roles
      // (Reporter, mode:"all") may read every assignment; scoped roles see only their own campuses.
      const scope = await CampusScopeHelper.resolve(au, this.repos);
      const rows = await this.repos.userCampus.loadForUser(au.churchId, userId);

      // PERM-04 read filtering — the result MUST never include out-of-scope campuses.
      switch (scope.mode) {
        case "all":
          return rows;
        case "deny":
          return [];
        case "scoped":
          return rows.filter((r) => scope.campusIds.includes(r.campusId));
      }
    });
  }

  @httpPost("/")
  public async assign(req: express.Request<{}, {}, { userId: string; campusId: string }>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await CampusScopeHelper.resolve(au, this.repos);

      // WRITE-CAPABILITY GATE (PERM-05): read-only Viewer/Reporter 401 even with the org-wide marker.
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      // SCOPE GATE (PERM-04): the body campusId must fall inside the caller's scope — no widening.
      const { userId, campusId } = req.body;
      if (!assertWritableCampus(scope, campusId)) return this.json({}, 401);

      return this.repos.userCampus.save({ churchId: au.churchId, addedBy: au.id, userId, campusId });
    });
  }

  @httpDelete("/:id")
  public async remove(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await CampusScopeHelper.resolve(au, this.repos);

      // WRITE-CAPABILITY GATE (PERM-05) BEFORE touching the row: a read-only Viewer/Reporter scoped
      // to a campus must NOT be able to revoke assignments (assertWritableCampus alone is insufficient
      // — a Viewer scoped to campus A would pass it for an A-campus row).
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      const row = await this.repos.userCampus.load(au.churchId, id);
      if (!row?.campusId) return this.json({}, 401);

      // SCOPE GATE: a Campus Admin can't revoke an assignment for a campus outside their scope.
      if (!assertWritableCampus(scope, row.campusId)) return this.json({}, 401);

      await this.repos.userCampus.delete(au.churchId, id);
      return {};
    });
  }
}
