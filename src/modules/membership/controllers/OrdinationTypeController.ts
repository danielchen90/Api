import { controller, httpGet, httpPost } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { CAMPUS_WRITE_PERMISSION, CAMPUS_ORGWIDE_MARKER } from "../helpers/index.js";
import { OrdinationType } from "../models/index.js";

/**
 * Ordination-type controlled-vocabulary API (ORD-01).
 *
 * The vocabulary is CHURCH-WIDE, not campus-scoped (the table has no campusId; OrdinationTypeRepo is
 * church-scoped only — see 02-02). Hence reads are auth-only church-scoped and writes are NOT routed
 * through assertWritableCampus (there is no campus to validate). It uses the dominant `/membership/...`
 * route prefix — the bare `/userCampuses` is the lone outlier per RESEARCH.
 *
 * WRITE GATE — Leadership-Admin-ONLY (RESEARCH "Role Mapping"): the POST requires BOTH
 *   1. au.checkAccess(CAMPUS_WRITE_PERMISSION) — the Edit capability (read-only Reporter/Viewer 401), AND
 *   2. au.checkAccess(CAMPUS_ORGWIDE_MARKER)  — the org-wide scope marker.
 * Each check alone is insufficient: the marker ALONE = org-wide scope but read-only Reporter holds it;
 * CAMPUS_WRITE_PERMISSION ALONE = Campus Admin, who is a campus-scoped writer and must NOT edit a
 * church-wide vocabulary. Requiring BOTH restricts vocabulary management to Leadership Admin (the only
 * role carrying the manage set AND the org-wide marker), without inventing a new permission.
 */
@controller("/membership/ordinationTypes")
export class OrdinationTypeController extends MembershipBaseController {

  // Auth-only, church-scoped active picker (active + non-removed, ordered by sortOrder then name).
  // Intentionally NOT write-gated and NOT campus-scoped — the vocabulary is church-wide.
  @httpGet("/")
  public async getAll(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      return this.repos.ordinationType.loadActive(au.churchId);
    });
  }

  // Admin-screen variant: every non-removed type including deactivated ones, so an admin can
  // re-activate or re-order. Same auth-only church-scoped read posture as getAll.
  @httpGet("/all")
  public async getAllIncludingInactive(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      return this.repos.ordinationType.loadAll(au.churchId);
    });
  }

  // Create / edit / deactivate — ALL flow through this single POST (the repo's save() branches on
  // id: absent → create, present → update; deactivate = a save with active=false on an existing id).
  @httpPost("/")
  public async save(req: express.Request<{}, {}, OrdinationType[] | OrdinationType>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // ORG-WIDE-WRITER GATE (Leadership-Admin-only): BOTH the Edit capability AND the org-wide marker.
      // Campus Admin (write, no marker) and read-only Reporter (marker, no write) both 401.
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION) || !au.checkAccess(CAMPUS_ORGWIDE_MARKER)) return this.json({}, 401);

      // Accept either a single type or a batch. churchId is ALWAYS server-derived (au.churchId) —
      // never trusted from the body, so a caller cannot write into another tenant.
      const items = Array.isArray(req.body) ? req.body : [req.body];
      const saved: OrdinationType[] = [];
      for (const item of items) {
        item.churchId = au.churchId;
        saved.push(await this.repos.ordinationType.save(item));
      }
      return Array.isArray(req.body) ? saved : saved[0];
    });
  }
}
