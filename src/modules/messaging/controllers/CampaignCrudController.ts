import { controller, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";
import { EmailCampaign } from "../models/index.js";

// The rich block-builder CRUD/preview/test-send/upload surface the Phase-12
// builder UI consumes (SND-03 / BLD-02 / BLD-04 / BLD-05 / BLD-06 / BLD-07).
//
// This is a SEPARATE controller from EmailCampaignController (the minimal
// send/status/settings spine, Phase 11). inversify-express-utils registers a
// controller by its CLASS NAME, so two classes may share the same @controller
// base route ("/messaging/campaigns") as long as the class names differ — a
// DUPLICATE class name crash-loops the container at boot. This class name is
// globally unique; the routes below do not collide with EmailCampaignController's
// (/send, /status, /settings, /domain-status) or CampaignAudienceController's
// (/:id/audience/*).
//
// AUTH: every endpoint gates on the UNPREFIXED "Campaigns" permission
// (campus-auth-perms-unprefixed + messaging-campaign-endpoints-use-campaigns-perm
// memories — a prefixed constant, or the membership "People" perm, 401s under a
// MessagingApi-scoped JWT). Reads gate on Campaigns/View; writes and the
// irreversible test-send gate on Campaigns/Send (mirrors EmailCampaignController's
// stronger-than-read write gate).
@controller("/messaging/campaigns")
export class CampaignCrudController extends MessagingBaseController {

  // ── SND-03: list draft + sent campaigns for the campaign list page ──
  // Newest-first, church-scoped. Returns the list-card fields (id/name/subject/
  // status/campusId/createdBy/createdAt + rollup counters). loadRecent is
  // church-scoped and removed=false; the list page filters draft/sent client-side.
  @httpGet("/")
  public async list(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed
      const campaigns = await this.repos.emailCampaign.loadRecent(au.churchId, 100);
      return campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        subject: c.subject,
        status: c.status,
        campusId: (c as any).campusId,
        createdBy: c.createdBy,
        createdAt: c.createdAt,
        recipientCount: c.recipientCount,
        sentCount: c.sentCount,
        failedCount: c.failedCount,
        version: c.version
      }));
    });
  }

  // ── SND-03 / BLD-04: reload one draft into the builder ──
  // Church-scoped load; 404-hide a missing / out-of-tenant id. Returns the full
  // design payload (blockJson / renderedHtml / subject / preheader /
  // audienceFilterJson / version / status) so the client can rehydrate the editor.
  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed
      const campaign = await this.repos.emailCampaign.load(au.churchId, id);
      if (!campaign) return this.json({ error: "not_found" }, 404);
      return campaign;
    });
  }

  // ── SND-03 / BLD-04: create a draft ──
  // status:"draft", createdBy = au.id (the codebase convention for the acting
  // person — SavedAudienceController; AuthenticatedUser exposes id === personId),
  // audience descriptor stored VERBATIM as audienceFilterJson (supports BOTH the
  // filter descriptor AND the {type:"people",personIds} descriptor from 12-02).
  // Subject is CR/LF-sanitized (Pitfall 6). Returns the created campaign incl.
  // version (=1) so the client seeds its OCC expectedVersion.
  @httpPost("/")
  public async create(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "Send" })) return this.json({}, 401); // write gate, MessagingApi-scoped, unprefixed
      const b = req.body ?? {};
      const model: EmailCampaign = {
        churchId: au.churchId,
        status: "draft",
        name: b.name,
        subject: CampaignCrudController.sanitizeHeader(b.subject),
        blockJson: CampaignCrudController.asJsonString(b.blockJson),
        renderedHtml: b.renderedHtml,
        renderedText: b.renderedText,
        audienceFilterJson: CampaignCrudController.asJsonString(b.audienceFilterJson ?? b.audienceDescriptor),
        templateId: b.templateId,
        createdBy: au.id
      };
      // campusId is not a first-class EmailCampaign field in this schema; persist it
      // through the model when the client sends it so the list can surface it.
      if (b.campusId) (model as any).campusId = b.campusId;
      const saved = await this.repos.emailCampaign.save(model);
      return this.json(saved, 200);
    });
  }

  // ── SND-03 / BLD-04: update a draft under OCC ──
  // Body carries expectedVersion + the updated builder fields. updateWithVersion
  // ALWAYS bumps version guarded by WHERE version=expectedVersion; a 0n result ⇒
  // stale version / concurrent edit / vanished row → 409 (never a lost write,
  // Pitfall 7). On success the bumped version is returned so the client uses it as
  // the next expectedVersion. Subject CR/LF-sanitized at save (Pitfall 6).
  @httpPost("/:id")
  public async update(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "Send" })) return this.json({}, 401); // write gate, MessagingApi-scoped, unprefixed

      const b = req.body ?? {};
      const expectedVersion: number = b.expectedVersion;

      // Load church-scoped so an out-of-tenant id 404-hides (never a blind update).
      const existing = await this.repos.emailCampaign.load(au.churchId, id);
      if (!existing) return this.json({ error: "not_found" }, 404);

      // Merge the updatable fields over the loaded row; keep status/createdBy/etc.
      const merged: EmailCampaign = {
        ...existing,
        id,
        churchId: au.churchId,
        name: b.name !== undefined ? b.name : existing.name,
        subject: b.subject !== undefined ? CampaignCrudController.sanitizeHeader(b.subject) : existing.subject,
        blockJson: b.blockJson !== undefined ? CampaignCrudController.asJsonString(b.blockJson) : existing.blockJson,
        renderedHtml: b.renderedHtml !== undefined ? b.renderedHtml : existing.renderedHtml,
        renderedText: b.renderedText !== undefined ? b.renderedText : existing.renderedText,
        audienceFilterJson: b.audienceFilterJson !== undefined
          ? CampaignCrudController.asJsonString(b.audienceFilterJson)
          : existing.audienceFilterJson,
        templateId: b.templateId !== undefined ? b.templateId : existing.templateId
      };
      // preheader is carried in blockJson/renderedHtml by the builder; no dedicated
      // column exists, so we do not invent one (BLD-04 persistence rides blockJson).

      const bumped = await this.repos.emailCampaign.updateWithVersion(merged, expectedVersion);
      if (bumped === 0n) return this.json({ error: "conflict" }, 409);

      return this.json({ id, version: expectedVersion + 1 }, 200);
    });
  }

  // ── shared helpers ──

  // Strip CR/LF from a header-bound value (subject) — header-injection defense
  // (Pitfall 6). Mirrors EmailCampaignController / CampaignSendWorker.
  protected static sanitizeHeader(value?: string): string {
    return (value || "").replace(/[\r\n]+/g, " ").trim();
  }

  // JSON columns are RAW STRINGS on the model (EmailCampaign contract — no typed
  // parse). Accept either a pre-stringified JSON string OR an object the client
  // sent and normalize to a string for the column; pass through null/undefined.
  protected static asJsonString(value: any): string | undefined {
    if (value === undefined || value === null) return value ?? undefined;
    return typeof value === "string" ? value : JSON.stringify(value);
  }
}
