import { controller, httpGet, httpPost, httpDelete, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { Permissions } from "../helpers/index.js";
import { Auxiliary } from "../models/index.js";

// Church-wide auxiliary vocabulary (the umbrella that per-campus group instances
// link to via groups.auxiliaryId). Reads are auth-only church-scoped; writes
// require the groups Edit capability. Cross-campus member rollups are assembled
// client-side from /groups (filtered by auxiliaryId) + /groupmembers.
@controller("/membership/auxiliaries")
export class AuxiliaryController extends MembershipBaseController {

  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const data = await this.repos.auxiliary.load(au.churchId, id);
      return this.repos.auxiliary.convertToModel(au.churchId, data);
    });
  }

  @httpGet("/")
  public async getAll(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const data = await this.repos.auxiliary.loadAll(au.churchId);
      return this.repos.auxiliary.convertAllToModel(au.churchId, data);
    });
  }

  @httpPost("/")
  public async save(req: express.Request<{}, {}, Auxiliary[]>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.groups.edit)) return this.json({}, 401);
      const promises: Promise<Auxiliary>[] = [];
      req.body.forEach((item) => { item.churchId = au.churchId; promises.push(this.repos.auxiliary.save(item)); });
      const result = await Promise.all(promises);
      return this.repos.auxiliary.convertAllToModel(au.churchId, result);
    });
  }

  @httpDelete("/:id")
  public async delete(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.groups.edit)) return this.json({}, 401);
      await this.repos.auxiliary.delete(au.churchId, id);
      return {};
    });
  }
}
