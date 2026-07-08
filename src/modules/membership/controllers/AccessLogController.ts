import { controller, httpGet } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";

/**
 * Scoped READ endpoints over the EXISTING access-log write path.
 *
 * The going-forward login capture already fires in UserChurchController.update()
 * (this.repos.accessLog.create on church selection) — this controller adds ONLY the
 * read side, it does NOT write.
 *
 * GATING: read-only, so it gates on People-VIEW, NOT a write permission. The
 * permission is UNPREFIXED (no apiName) — a prefixed/write gate 401s read-only
 * admins on every campus request (campus-auth memory / mirrors
 * LeadershipReportController).
 *
 * NOTE: the class name MUST be globally unique across ALL modules —
 * inversify-express-utils registers controllers by class name and throws at startup
 * on a collision. `AccessLogController` is free (grep confirmed no collision).
 */
@controller("/membership/accessLogs")
export class AccessLogController extends MembershipBaseController {

  @httpGet("/recent")
  public async recent(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "People", action: "View" })) return this.json({}, 401);
      return this.repos.accessLog.loadRecent(au.churchId);
    });
  }

  @httpGet("/weeklycount")
  public async weeklyCount(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "People", action: "View" })) return this.json({}, 401);
      return this.repos.accessLog.loadWeeklyCounts(au.churchId);
    });
  }
}
