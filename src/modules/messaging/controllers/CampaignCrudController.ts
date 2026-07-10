import { controller, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";
import { EmailCampaign, EmailTemplate } from "../models/index.js";
import { RecipientResolver } from "../helpers/RecipientResolver.js";
import { CampaignRenderHelper, CampaignRenderContext } from "../helpers/CampaignRenderHelper.js";
import { VerifiedDomainGate } from "../helpers/VerifiedDomainGate.js";
import { SesEmailDeliveryProvider } from "../helpers/SesEmailDeliveryProvider.js";
import { FileStorageHelper } from "@churchapps/apihelper";
import { Environment } from "../../../shared/helpers/Environment.js";

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

  // ── BLD-02: reusable-template save/list/get seam ──
  // Declared FIRST so the LITERAL "/templates" routes register before the "/:id"
  // catch-all (inversify-express-utils = declaration order, Express = first match
  // wins). This is BLD-02's concrete home: save the current builder design as a
  // REUSABLE emailTemplate (blockJson) and list/reload those when starting or
  // replacing a campaign design. Reuses the EXISTING EmailTemplateRepo (which
  // already persists/reads blockJson — Phase 9) — no new table, no parallel repo.
  // The legacy /emailTemplates controller and its send path are UNTOUCHED.

  // save-as-template — persist the builder design as a reusable template.
  @httpPost("/templates")
  public async saveTemplate(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "Send" })) return this.json({}, 401); // write gate, MessagingApi-scoped, unprefixed
      const b = req.body ?? {};
      // blockJson is the current builder design (editor.saveDesign); htmlContent is
      // the exported render so the template also works for legacy HTML senders.
      const model: EmailTemplate = {
        churchId: au.churchId, // server-derived; never trust body churchId
        name: b.name,
        subject: CampaignCrudController.sanitizeHeader(b.subject),
        blockJson: CampaignCrudController.asJsonString(b.blockJson),
        htmlContent: b.renderedHtml ?? b.htmlContent ?? "",
        // Templates are CHURCH-scoped (no campusId column on emailTemplates). Tag
        // builder designs with a stable category so the picker can group them.
        category: b.category ?? "Saved designs"
      };
      const saved = await this.repos.emailTemplate.save(model);
      return this.json({ id: saved.id, name: saved.name });
    });
  }

  // list-templates — saved + legacy templates for the picker. hasBlockJson lets the
  // UI distinguish builder-designs from HTML-only (blockJson NULL) templates; both
  // MUST list (BLD-02 back-compat) and the list never carries the full blockJson.
  @httpGet("/templates")
  public async listTemplates(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed
      return this.repos.emailTemplate.loadByChurchId(au.churchId);
    });
  }

  // get-template — one template incl. blockJson so the builder can
  // editor.loadDesign(JSON.parse(blockJson)). 404-hide missing / church-mismatch.
  // A legacy blockJson-NULL template returns with blockJson:null (UI falls back to
  // htmlContent / disables "load into builder") — it does NOT error (BLD-02).
  @httpGet("/templates/:id")
  public async getTemplate(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed
      const tpl = await this.repos.emailTemplate.loadById(au.churchId, id);
      if (!tpl) return this.json({ error: "not_found" }, 404);
      return tpl;
    });
  }

  // ── BLD-05: image upload → absolute URL for the email builder ──
  // Declared with the other LITERAL single-segment POST routes (before "/:id") so
  // Express (first-match-wins) never routes POST /upload-image into the draft
  // update handler. Unlayer's registerCallback('image', ...) uploads an image and
  // expects done({url}). Mirror content/FileController.saveFile: decode the base64
  // data URL, store under a church-namespaced campaigns subfolder, return an
  // ABSOLUTE contentRoot URL (Pitfall 4 — email clients strip relative src; on
  // Railway with FILE_STORE unset, contentRoot is the public base over the
  // /app/content volume, per railway-api-local-volume-storage memory). Reuse the
  // EXACT FileStorageHelper.store + Environment.contentRoot mechanism FileController
  // uses; do NOT invent new storage. Route is :id-agnostic so it works before the
  // draft exists (the builder can upload while composing a brand-new campaign).
  @httpPost("/upload-image")
  public async uploadImage(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "Send" })) return this.json({}, 401); // write gate, MessagingApi-scoped, unprefixed

      const b = req.body ?? {};
      // Accept the same body shape FileController uses: a base64 data-URL in
      // fileContents (+ fileType + fileName). The client sends what Unlayer hands it.
      const fileContents: string = b.fileContents ?? b.file ?? "";
      const fileType: string = b.fileType ?? b.contentType ?? "image/png";
      const rawName: string = (b.fileName ?? b.name ?? ("image-" + Date.now())).toString();
      if (!fileContents) return this.json({ error: "no_file", code: "NO_FILE" }, 422);

      // Sanitize the file name to a safe basename (no path traversal / separators).
      const fileName = rawName.replace(/[^\w.\-]+/g, "_").replace(/^_+/, "").slice(-120) || ("image-" + Date.now());

      // key namespaced under the church + a campaigns subfolder (mirrors
      // FileController's "/" + churchId + "/files/..." convention).
      const key = "/" + au.churchId + "/files/campaigns/" + fileName;

      // A base64 data URL is "data:<mime>;base64,<payload>"; take the payload after
      // the comma (FileController does the same split). Fall back to the raw string.
      const base64 = fileContents.includes(",") ? fileContents.split(",")[1] : fileContents;
      const buffer = Buffer.from(base64, "base64");
      await FileStorageHelper.store(key, fileType, buffer);

      // ABSOLUTE URL (contentRoot-prefixed) + a cache-buster dt — exactly what
      // FileController.saveFile builds. Ready to feed Unlayer done({url}).
      const url = Environment.contentRoot + key + "?dt=" + Date.now().toString();
      return this.json({ url });
    });
  }

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
  // NOTE: the reusable-template routes below use the LITERAL "/templates" segment.
  // inversify-express-utils registers this controller's routes in method-declaration
  // order and Express matches first-registered-wins, so the concrete "/templates"
  // GET/POST handlers are declared BEFORE this "/:id" catch-all. This "/:id" handler
  // additionally guards the reserved "templates" segment as belt-and-suspenders so a
  // future re-order can never route /templates into a campaign load.
  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed
      if (id === "templates") return this.json({ error: "not_found" }, 404); // reserved literal
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

      if (id === "templates" || id === "upload-image") return this.json({ error: "not_found" }, 404); // reserved literals (their own handlers win by declaration order)
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

  // ── BLD-06: server-side preview against a LIVE pre-freeze recipient ──
  // (OPEN QUESTION #3) BEFORE freeze there are NO campaignRecipients rows, so the
  // preview resolves the audience LIVE via the SAME RecipientResolver the freeze
  // uses (zero compose→send drift) and picks one deliverable's mergeData. A
  // recipientIndex param steps "next recipient" (wraps on overflow). Render flows
  // through the ONE shared CampaignRenderHelper so the previewed bytes are
  // byte-identical to what a real send emits (strip + merge + footer + text). NO
  // persistence, NO send.
  @httpPost("/:id/preview")
  public async preview(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed

      const campaign = await this.repos.emailCampaign.load(au.churchId, id);
      if (!campaign) return this.json({ error: "not_found" }, 404);

      // Resolve LIVE. The descriptor comes from the body (the builder's current
      // audience pick) or falls back to the campaign's stored audienceFilterJson.
      const descriptor = req.body?.descriptor ?? CampaignCrudController.parseJson(campaign.audienceFilterJson);
      const resolved = await RecipientResolver.resolve(au, this.repos, descriptor);
      const total = resolved.deliverable.length;
      if (total === 0) return this.json({ error: "no_recipients", code: "NO_DELIVERABLE" }, 422);

      const idx = CampaignCrudController.wrapIndex(req.body?.recipientIndex, total);
      const recipient = resolved.deliverable[idx];

      // Constant-per-render footer context from the SAME enriched mergeData (12-02
      // carries church/campus/ordination keys). No membership-repo/HTTP lookup —
      // the resolver already enriched the snapshot (drift-free by construction).
      const context = CampaignCrudController.renderContext(recipient.mergeData);
      const rendered = await CampaignRenderHelper.render(campaign, recipient.mergeData, context);

      return {
        html: rendered.html,
        subject: rendered.subject,
        recipientEmail: recipient.email,
        recipientIndex: idx,
        totalRecipients: total
      };
    });
  }

  // ── BLD-07: test-send — one real email, ZERO stat pollution ──
  // FIRST hard-gate on VerifiedDomainGate.isSendable (mirror EmailCampaignController
  // — 422 DOMAIN_UNVERIFIED). Resolve LIVE, pick recipient[index]'s mergeData,
  // render via the shared helper, send ONE email via SES to the test address
  // (defaults client-side to the logged-in staff email). CRITICAL (Pitfall 5):
  // this path NEVER writes campaignRecipients and NEVER calls updateCounters —
  // persist NOTHING. from/replyTo derive from the church email settings exactly as
  // the send worker does (no re-derivation of SES config).
  @httpPost("/:id/test-send")
  public async testSend(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "Send" })) return this.json({}, 401); // write gate, MessagingApi-scoped, unprefixed

      const campaign = await this.repos.emailCampaign.load(au.churchId, id);
      if (!campaign) return this.json({ error: "not_found" }, 404);

      // From-identity from the church email settings (same as the worker).
      const settings = await this.repos.churchEmailSettings.loadByChurch(au.churchId);
      if (!settings || !settings.fromEmail) {
        return this.json({ error: "No sender identity configured", code: "NO_EMAIL_SETTINGS" }, 422);
      }

      // LIVE verified-domain gate BEFORE composing/sending (DLV-02).
      const domain = CampaignCrudController.domainOf(settings.fromEmail);
      if (!(await VerifiedDomainGate.isSendable(domain))) {
        return this.json({ error: "Sending domain not verified", code: "DOMAIN_UNVERIFIED" }, 422);
      }

      // Test address defaults to the acting staff email (client can override).
      const to = ((req.body?.to ?? au.email) || "").trim();
      if (!CampaignCrudController.isValidEmail(to)) {
        return this.json({ error: "invalid_test_address", code: "INVALID_TO" }, 422);
      }

      // Resolve LIVE for merge data (same resolver / descriptor path as preview).
      const descriptor = req.body?.descriptor ?? CampaignCrudController.parseJson(campaign.audienceFilterJson);
      const resolved = await RecipientResolver.resolve(au, this.repos, descriptor);
      // If there is no deliverable audience yet, still allow a test with empty merge
      // data so a designer can proof the layout — merge fields fall back per helper.
      const total = resolved.deliverable.length;
      const mergeData = total > 0
        ? resolved.deliverable[CampaignCrudController.wrapIndex(req.body?.recipientIndex, total)].mergeData
        : {};

      const context = CampaignCrudController.renderContext(mergeData);
      const rendered = await CampaignRenderHelper.render(campaign, mergeData, context);

      const fromName = CampaignCrudController.sanitizeHeader(settings.fromName);
      const from = fromName ? `${fromName} <${settings.fromEmail}>` : settings.fromEmail;
      const replyTo = settings.replyTo ? CampaignCrudController.sanitizeHeader(settings.replyTo) : undefined;

      const provider = new SesEmailDeliveryProvider();
      const result = await provider.send({
        from,
        replyTo,
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        // campaignId is for FUTURE SNS correlation ONLY — it is NOT persisted here
        // and never touches campaignRecipients / counters (Pitfall 5).
        campaignId: id,
        recipientId: "test-send"
      });

      if (!result.success) {
        return this.json({ error: "send_failed", detail: result.error }, 502);
      }
      return this.json({ sent: true, to, renderedFromRecipient: total > 0 });
    });
  }

  // Derive the constant-per-render footer context from enriched mergeData. Mirrors
  // CampaignSendWorker.renderContext so preview/test/real render identically.
  protected static renderContext(data: Record<string, string | undefined>): CampaignRenderContext {
    const d = data || {};
    return {
      churchName: d.churchName,
      campusName: d.campusName,
      address1: d.address1 ?? d.campusAddress,
      address2: d.address2,
      city: d.city,
      state: d.state,
      zip: d.zip,
      country: d.country
    };
  }

  // Wrap a client-supplied recipient index into [0,total) (default 0).
  protected static wrapIndex(raw: any, total: number): number {
    if (total <= 0) return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n) % total;
  }

  // Parse a RAW JSON string column back to an object for the resolver descriptor.
  protected static parseJson(value?: string): any {
    if (!value) return undefined;
    try { return JSON.parse(value); } catch { return undefined; }
  }

  // The part after the last '@' (lowercased). Empty if malformed.
  protected static domainOf(email: string): string {
    const at = (email || "").lastIndexOf("@");
    return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
  }

  // Tiny syntactic address check (no library — mirrors EmailCampaignController).
  protected static isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
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
