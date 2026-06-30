import { controller, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { Permissions } from "../helpers/index.js";
import { PersonPhotoCrop } from "../models/index.js";

/**
 * Person photo-crop transform API (PHO-04) — the "store-once, re-crop via
 * transform" contract Phase 6 consumes to render the CR80 card photo from the
 * single stored member photo.
 *
 * This is NOT campus-scoped (a crop is not campus-intrinsic — RESEARCH Open Q4);
 * authorization flows through the People permission set, mirroring how the member
 * PHOTO itself is gated. There is no AuditLog (a crop transform is not an audited
 * credential event — PersonController photo writes are likewise not audited).
 *
 *   READS  — gated by Permissions.people.view.
 *   WRITES — gated by Permissions.people.edit; churchId is ALWAYS server-derived
 *            (au.churchId), never trusted from the body (the standing tenancy
 *            rule). The POST upserts on (churchId, personId, purpose).
 *
 * Endpoint contract (for Phase 6):
 *   GET  /membership/personPhotoCrops?personId=  → that person's crop rows
 *   GET  /membership/personPhotoCrops/:id        → one crop row
 *   POST /membership/personPhotoCrops            → upsert; body = single object
 *        or array of { personId, purpose:'license', cropX, cropY, cropWidth,
 *        cropHeight, rotation, sourceUpdated } with crop fields normalized 0..1.
 */
@controller("/membership/personPhotoCrops")
export class PersonPhotoCropController extends MembershipBaseController {

  // Clamp a normalized crop component into [0,1] defensively (never trust the body).
  private clamp01(n: any): number {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // Get-by-id — People/View. Missing/out-of-tenant id → null (404-hide via repo).
  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.people.view)) return this.json({}, 401);
      return this.repos.personPhotoCrop.load(au.churchId, id);
    });
  }

  // List a person's crops — People/View. ?personId= is required (400 if absent).
  @httpGet("/")
  public async getAll(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.people.view)) return this.json({}, 401);
      const personId = req.query.personId as string | undefined;
      if (!personId) return this.json({}, 400);
      return this.repos.personPhotoCrop.loadForPerson(au.churchId, personId);
    });
  }

  // Upsert the license crop(s) — People/Edit. churchId is ALWAYS au.churchId.
  @httpPost("/")
  public async save(req: express.Request<{}, {}, PersonPhotoCrop[] | PersonPhotoCrop>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.people.edit)) return this.json({}, 401);

      const items = Array.isArray(req.body) ? req.body : [req.body];
      const saved: PersonPhotoCrop[] = [];
      for (const item of items) {
        // NEVER trust a body churchId — server-derive tenancy/attribution.
        item.churchId = au.churchId;
        item.createdBy = au.id;
        item.updatedBy = au.id;
        item.purpose = item.purpose || "license";
        // Defensive clamp — crop components are normalized 0..1.
        item.cropX = this.clamp01(item.cropX);
        item.cropY = this.clamp01(item.cropY);
        item.cropWidth = this.clamp01(item.cropWidth);
        item.cropHeight = this.clamp01(item.cropHeight);
        saved.push(await this.repos.personPhotoCrop.save(item));
      }
      return Array.isArray(req.body) ? saved : saved[0];
    });
  }
}
