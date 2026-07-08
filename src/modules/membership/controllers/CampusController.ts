import { controller, httpGet, httpPost, httpDelete, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { Permissions, GeoHelper } from "../helpers/index.js";
import { Campus } from "../models/index.js";

@controller("/membership/campuses")
export class MembershipCampusController extends MembershipBaseController {

  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const data = await this.repos.campus.load(au.churchId, id);
      return this.repos.campus.convertToModel(au.churchId, data);
    });
  }

  @httpGet("/")
  public async getAll(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const data = await this.repos.campus.loadAll(au.churchId);
      return this.repos.campus.convertAllToModel(au.churchId, data);
    });
  }

  // Anonymous, minimal projection (id + name) for member-facing campus filters
  // such as the public Groups browser in B1App.
  @httpGet("/public/:churchId")
  public async getPublic(@requestParam("churchId") churchId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      const data = await this.repos.campus.loadAll(churchId);
      return this.repos.campus.convertAllToModel(churchId, data).map((c) => ({ id: c.id, name: c.name }));
    });
  }

  @httpPost("/")
  public async save(req: express.Request<{}, {}, Campus[]>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.settings.edit)) return this.json({}, 401);
      const addressStr = (c: any) => [c?.address1, c?.address2, c?.city, c?.state, c?.zip, c?.country].map((x) => x || "").join("|");
      const result: Campus[] = [];
      for (const item of req.body) {
        item.churchId = au.churchId;
        // Compare against the stored row BEFORE saving so we only geocode when the
        // address changed or coordinates are still missing (OSM courtesy limit).
        const existing = item.id ? await this.repos.campus.load(au.churchId, item.id) : null;
        const needsGeo = !!(item.address1 || item.city || item.zip) && (!existing || addressStr(existing) !== addressStr(item) || existing.latitude === null || existing.latitude === undefined);
        const saved = await this.repos.campus.save(item);
        // Best-effort: a geocoder failure must never fail the campus save.
        if (needsGeo) try { await GeoHelper.updateCampusAddress(saved); } catch { /* ignore geocode errors */ }
        result.push(saved);
      }
      return this.repos.campus.convertAllToModel(au.churchId, result);
    });
  }

  @httpDelete("/:id")
  public async delete(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.settings.edit)) return this.json({}, 401);
      await this.repos.campus.delete(au.churchId, id);
      return {};
    });
  }
}
