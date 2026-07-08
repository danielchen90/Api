import { controller, httpGet, httpPost, httpDelete, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { Permissions } from "../helpers/index.js";

// Assignment API for auxiliary "presidents" (userAuxiliaries). All operations are
// church-admin only (Settings Edit) — assigning a cross-campus president is an
// org-wide decision. Assign accepts a personId (resolved to the login user via
// userChurches) or a userId directly.
@controller("/userAuxiliaries")
export class UserAuxiliaryController extends MembershipBaseController {

  @httpGet("/auxiliary/:auxiliaryId")
  public async listForAuxiliary(@requestParam("auxiliaryId") auxiliaryId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.settings.edit)) return this.json({}, 401);
      return this.repos.userAuxiliary.loadPresidents(au.churchId, auxiliaryId);
    });
  }

  @httpPost("/")
  public async assign(req: express.Request<{}, {}, { userId?: string; personId?: string; auxiliaryId: string }>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.settings.edit)) return this.json({}, 401);
      const { auxiliaryId } = req.body;
      let userId = req.body.userId;
      if (!userId && req.body.personId) {
        const uc = await this.repos.userChurch.loadByPersonId(req.body.personId, au.churchId);
        userId = uc?.userId;
      }
      if (!userId || !auxiliaryId) return this.json({ error: "This person has no login account, or auxiliary is missing." }, 400);
      return this.repos.userAuxiliary.save({ churchId: au.churchId, addedBy: au.id, userId, auxiliaryId });
    });
  }

  @httpDelete("/:id")
  public async remove(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.settings.edit)) return this.json({}, 401);
      await this.repos.userAuxiliary.delete(au.churchId, id);
      return {};
    });
  }
}
