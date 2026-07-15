import { controller, httpGet, httpPost, httpDelete, requestParam } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";
import { SavedAudience } from "../models/index.js";

// AUD-09 — reusable NAMED audiences (Phase 10, Plan 04). Church-scoped CRUD over
// the savedAudiences DESCRIPTOR (label + audienceType + targetId + filterJson).
// Stores ONLY the descriptor — NEVER a resolved person list — so a saved
// audience re-scopes to whoever runs it later (RESEARCH Open Q3): a saved "whole
// church" yields different sets for a Campus Admin vs a Leadership Admin, correct
// by design.
//
// churchId is ALWAYS server-derived from `au.churchId`, never trusted from the
// body. Gated on the UNPREFIXED People-View read for parity with the audience
// resolver seam (RESEARCH: "gate on the same People-View UNPREFIXED read used by
// the resolver" — see `campus-auth-perms-unprefixed` memory; EmailTemplateController
// exposes no obvious content-type gate to reuse). A saved audience is church-wide
// comms configuration, not campus-scoped, so no assertWritableCampus.
@controller("/messaging/audiences")
export class SavedAudienceController extends MessagingBaseController {

  // List the church's saved audiences (active only).
  @httpGet("/")
  public async getAll(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "People", action: "View" })) return this.json({}, 401); // UNPREFIXED
      return this.repos.savedAudience.loadAll(au.churchId);
    });
  }

  // Save one or more named audiences (body: single object or array of
  // { label, audienceType, targetId?, filterJson? }). churchId + createdBy are
  // server-derived; the body churchId is never trusted.
  @httpPost("/")
  public async save(req: express.Request<{}, {}, SavedAudience | SavedAudience[]>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "People", action: "View" })) return this.json({}, 401); // UNPREFIXED
      const items = Array.isArray(req.body) ? req.body : [req.body];
      return Promise.all(items.map((a) => {
        a.churchId = au.churchId;   // server-derived; never trust body churchId
        a.createdBy = au.id;
        return this.repos.savedAudience.save(a);
      }));
    });
  }

  // Update a saved audience's descriptor in place (label + audienceType +
  // targetId + filterJson). POST-to-update (ApiHelper has no put()) — mirrors the
  // POST /campaigns/:id house style. id comes from the ROUTE param, churchId is
  // server-derived; neither is trusted from the body. UNPREFIXED People/View gate.
  @httpPost("/:id")
  public async update(@requestParam("id") id: string, req: express.Request<{}, {}, SavedAudience>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "People", action: "View" })) return this.json({}, 401); // UNPREFIXED
      const model = req.body;
      model.id = id;                 // trust the route param, NOT the body
      model.churchId = au.churchId;  // server-derived, never the body's churchId
      return this.repos.savedAudience.update(au.churchId, model);
    });
  }

  // Soft-delete a saved audience (church-scoped).
  @httpDelete("/:id")
  public async delete(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "People", action: "View" })) return this.json({}, 401); // UNPREFIXED
      await this.repos.savedAudience.delete(au.churchId, id);
      return this.json({});
    });
  }
}
