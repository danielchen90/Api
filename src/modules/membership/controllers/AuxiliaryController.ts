import { controller, httpGet, httpPost, httpDelete, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { Permissions, AuxiliaryScopeHelper } from "../helpers/index.js";
import { Auxiliary } from "../models/index.js";

// Church-wide auxiliary vocabulary (the umbrella that per-campus group instances
// link to via groups.auxiliaryId). Reads are AUXILIARY-SCOPED: org-wide admins
// (Leadership Admin/Reporter) see all; an Auxiliary President sees only their
// assigned auxiliaries; everyone else sees none. Create/update/delete require
// Settings Edit (church-admin only). The rollup assembles instances + members
// server-side so a scoped president needs no broad group/member permissions.
@controller("/membership/auxiliaries")
export class AuxiliaryController extends MembershipBaseController {

  @httpGet("/:id/rollup")
  public async rollup(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await AuxiliaryScopeHelper.resolve(au, this.repos);
      if (!AuxiliaryScopeHelper.canRead(scope, id)) return this.json({}, 401);
      const aux = await this.repos.auxiliary.load(au.churchId, id);
      const groupRows = (await this.repos.group.loadAll(au.churchId)).filter((g: any) => g.auxiliaryId === id);
      const groupIds = groupRows.map((g: any) => g.id);
      const memberRows = groupIds.length ? await this.repos.groupMember.loadForGroups(au.churchId, groupIds) : [];
      return {
        auxiliary: this.repos.auxiliary.convertToModel(au.churchId, aux),
        instances: this.repos.group.convertAllToModel(au.churchId, groupRows),
        members: this.repos.groupMember.convertAllToModel(au.churchId, memberRows)
      };
    });
  }

  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await AuxiliaryScopeHelper.resolve(au, this.repos);
      if (!AuxiliaryScopeHelper.canRead(scope, id)) return {}; // out-of-scope id is indistinguishable from not-found
      const data = await this.repos.auxiliary.load(au.churchId, id);
      return this.repos.auxiliary.convertToModel(au.churchId, data);
    });
  }

  @httpGet("/")
  public async getAll(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await AuxiliaryScopeHelper.resolve(au, this.repos);
      if (scope.mode === "deny") return [];
      let rows = await this.repos.auxiliary.loadAll(au.churchId);
      if (scope.mode === "scoped") rows = rows.filter((a: any) => scope.auxiliaryIds.includes(a.id));

      // Rollup counts (instances / campuses / members) computed server-side so a
      // scoped president doesn't need /groups access to see their list.
      const counts = new Map<string, { instances: number; campuses: Set<string>; members: number }>();
      for (const g of await this.repos.group.loadAll(au.churchId) as any[]) {
        const aid = g.auxiliaryId;
        if (!aid) continue;
        if (!counts.has(aid)) counts.set(aid, { instances: 0, campuses: new Set(), members: 0 });
        const c = counts.get(aid)!;
        c.instances++;
        if (g.campusId) c.campuses.add(g.campusId);
        c.members += Number(g.memberCount || 0);
      }
      return rows.map((a: any) => {
        const c = counts.get(a.id);
        return { ...this.repos.auxiliary.convertToModel(au.churchId, a), instanceCount: c?.instances || 0, campusCount: c?.campuses.size || 0, memberCount: c?.members || 0 };
      });
    });
  }

  @httpPost("/")
  public async save(req: express.Request<{}, {}, Auxiliary[]>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.settings.edit)) return this.json({}, 401);
      const promises: Promise<Auxiliary>[] = [];
      req.body.forEach((item) => { item.churchId = au.churchId; promises.push(this.repos.auxiliary.save(item)); });
      const result = await Promise.all(promises);
      return this.repos.auxiliary.convertAllToModel(au.churchId, result);
    });
  }

  @httpDelete("/:id")
  public async delete(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.settings.edit)) return this.json({}, 401);
      await this.repos.auxiliary.delete(au.churchId, id);
      return {};
    });
  }
}
