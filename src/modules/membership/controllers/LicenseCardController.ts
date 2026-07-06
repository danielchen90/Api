import { controller, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import {
  CampusScopeHelper,
  assertWritableCampus,
  CAMPUS_WRITE_PERMISSION,
  AuditLogHelper,
  FileStorageHelper,
  UniqueIdHelper
} from "../helpers/index.js";
import { buildPreviewData } from "../helpers/renderBindings.js";
import {
  LicenseRenderHelper,
  NO_CALIBRATION,
  type Calibration,
  type RenderAssets,
  type LicenseTemplateLayout
} from "../helpers/LicenseRenderHelper.js";

/**
 * CR80 license-card render + audit API (PRT-01 / PRT-03 / PRT-05).
 *
 * Implements the "render-once-then-confirm" flow so that "the preview IS the PDF" is
 * PROVABLE — the exact bytes shown to the operator are archived once and later reused,
 * never re-rendered (re-rendering risks font/date/sub-pixel drift the fidelity constraint
 * forbids):
 *
 *   POST /render   — renders ONE CR80 PDF for a campus-authorized credential, archives the
 *                    blob in FileStorage, returns the exact bytes + renderId + templateVersion.
 *                    Writes NO audit row (a preview is not a print).
 *   POST /testCard — renders the per-workstation calibration alignment card (PRT-05). No
 *                    archival, no audit — it is a printer-calibration aid.
 *   POST /confirm  — writes the licenseCards audit row (PRT-03) referencing the ALREADY-stored
 *                    blob. NO re-render (bytes must be provably identical to the preview).
 *
 * CAMPUS SCOPE (PERM-07 names "render"/"print"): render and confirm both resolve the caller's
 * CampusScope server-side and assert the credential's campusId is writable — a Campus Admin can
 * neither render nor print another campus's credential. The write-capability gate
 * (CAMPUS_WRITE_PERMISSION, UNPREFIXED per the campus-auth memory) precedes the scope gate, so a
 * read-only Viewer/Reporter cannot drive a render even for an in-scope campus.
 *
 * IMAGE INLINING: the render core (LicenseRenderHelper.buildHtml) inlines the template
 * background / logo refs and the person photo from disk itself (inlineImage reads the
 * FileStorage key path — FileStorageHelper has no read API). The controller passes the person
 * photo KEY + crop transform via `assets`; a missing photo/crop simply renders a blank region
 * (warn-but-allow — the proof dialog surfaces it).
 */
@controller("/membership/licenseCards")
export class LicenseCardController extends MembershipBaseController {

  // Shared render pipeline for /render: resolve scope + guards, fetch the row set, build the
  // binding data + photo assets, render + archive the PDF. Returns the bytes + metadata OR a
  // json() error response (401/404) which the caller returns verbatim.
  @httpPost("/render")
  public async render(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await CampusScopeHelper.resolve(au, this.repos);

      // 1. WRITE-CAPABILITY GATE first — read-only roles 401 even for an in-scope campus.
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      const body = req.body as { personOrdinationId?: string; templateId?: string; calibration?: Calibration };
      if (!body?.personOrdinationId || !body?.templateId) return this.json({}, 400);

      // 2. Load the credential SCOPED — out-of-scope / missing is a 404-hide (Pitfall 7).
      const ordination = await this.repos.personOrdination.load(au.churchId, body.personOrdinationId, scope);
      if (!ordination?.id) return this.json({}, 404);

      // 3. SCOPE GATE on the credential's campusId — a scoped caller cannot render cross-campus.
      if (!assertWritableCampus(scope, ordination.campusId)) return this.json({}, 401);

      // 4. Load the template + JSON layout (church-wide vocabulary; not campus-scoped).
      const template = await this.repos.licenseTemplate.load(au.churchId, body.templateId);
      if (!template?.id || !template.layoutJson) return this.json({}, 404);
      const layout = JSON.parse(template.layoutJson) as LicenseTemplateLayout;

      // 5. Fetch the binding record set: person (→ Name object), ordination type, campus, church.
      const personRow = await this.repos.person.load(au.churchId, ordination.personId);
      const person = personRow ? this.repos.person.convertToModel(au.churchId, personRow) : undefined;
      const ordinationType = ordination.ordinationTypeId
        ? await this.repos.ordinationType.load(au.churchId, ordination.ordinationTypeId)
        : undefined;
      const campus = ordination.campusId
        ? await this.repos.campus.load(au.churchId, ordination.campusId)
        : undefined;
      const church = await this.repos.church.load(au.churchId, au.churchId);
      const data = buildPreviewData(person as any, ordination as any, ordinationType as any, campus as any, church as any);

      // 6. Photo (PRT-07): pass the person-photo FileStorage KEY + the 'license' crop transform;
      //    the render core inlines the bytes from disk. Absent photo/crop → blank region.
      const assets: RenderAssets = {};
      if ((person as any)?.photoUpdated) {
        assets.photoSrc = "/" + au.churchId + "/membership/people/" + ordination.personId + ".png";
        const crop = await this.repos.personPhotoCrop.loadByPurpose(au.churchId, ordination.personId, "license");
        if (crop?.id) {
          assets.crop = {
            cropX: crop.cropX,
            cropY: crop.cropY,
            cropWidth: crop.cropWidth,
            cropHeight: crop.cropHeight,
            rotation: crop.rotation
          };
        }
      }

      // 7. Render ONCE (calibration is baked into the bytes as CSS vars — PRT-05 render side).
      const calibration = body.calibration ?? NO_CALIBRATION;
      const html = LicenseRenderHelper.buildHtml(layout, data, calibration, assets);
      const pdf = await LicenseRenderHelper.renderPdf(html);

      // 8. Archive the EXACT bytes before returning them (mirror savePhoto/storeLayoutImages).
      //    /confirm later references this same blob — it is NEVER re-rendered.
      const renderId = UniqueIdHelper.shortId();
      const key = "/" + au.churchId + "/membership/licenseCards/" + renderId + ".pdf";
      await FileStorageHelper.store(key, "application/pdf", pdf);

      // 9. Stream the exact bytes + the metadata /confirm needs (via headers so the B1Admin
      //    fetch→blob path gets the raw bytes for the iframe). NO licenseCards row here.
      //    Expose the custom headers so the cross-origin B1Admin fetch can READ them.
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("X-Render-Id", renderId);
      res.setHeader("X-Template-Version", String(template.currentVersion ?? 1));
      res.setHeader("X-Campus-Id", ordination.campusId ?? "");
      res.setHeader("Access-Control-Expose-Headers", "X-Render-Id, X-Template-Version, X-Campus-Id");
      return res.send(pdf);
    });
  }

  // Per-workstation calibration alignment card (PRT-05). Auth + write-gated (only print
  // operators calibrate), but needs NO per-credential campus target. No archival, no audit.
  @httpPost("/testCard")
  public async testCard(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);
      const body = req.body as { calibration?: Calibration };
      const calibration = body?.calibration ?? NO_CALIBRATION;
      const html = LicenseRenderHelper.buildTestCardHtml(calibration);
      const pdf = await LicenseRenderHelper.renderPdf(html);
      res.setHeader("Content-Type", "application/pdf");
      return res.send(pdf);
    });
  }

  // Write the PRT-03 print-audit row on a CONFIRMED print. References the blob ALREADY
  // archived by /render (built from renderId) — NEVER re-renders (re-rendering risks
  // font/date/sub-pixel drift, so the audited bytes could diverge from the operator's
  // preview — forbidden by the fidelity constraint). An unconfirmed /render leaves an
  // orphan blob, which is acceptable (retention/rotation explicitly deferred).
  @httpPost("/confirm")
  public async confirm(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await CampusScopeHelper.resolve(au, this.repos);

      // Same guards as /render: write-capability gate, then campus scope on the credential.
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      const body = req.body as {
        renderId?: string;
        personOrdinationId?: string;
        templateId?: string;
        templateVersion?: number;
      };
      if (!body?.renderId || !body?.personOrdinationId || !body?.templateId) return this.json({}, 400);

      const ordination = await this.repos.personOrdination.load(au.churchId, body.personOrdinationId, scope);
      if (!ordination?.id) return this.json({}, 404);
      if (!assertWritableCampus(scope, ordination.campusId)) return this.json({}, 401);

      // pdfRef = the archived key from /render (cache-busted like storeLayoutImages). NO re-render.
      const pdfRef = "/" + au.churchId + "/membership/licenseCards/" + body.renderId + ".pdf?dt=" + Date.now();

      // churchId + createdBy are ALWAYS server-derived (never from the body).
      const saved = await this.repos.licenseCard.save({
        churchId: au.churchId,
        personId: ordination.personId,
        personOrdinationId: ordination.id,
        campusId: ordination.campusId,
        templateId: body.templateId,
        templateVersion: Number(body.templateVersion ?? 1),
        pdfRef,
        createdAt: new Date(),
        createdBy: au.id
      });
      return saved;
    });
  }

  // ── Card-lifecycle endpoints (PRT-04) — reprint / void / markPrinted ──
  //
  // Each mirrors the render/confirm guard order: write-capability gate (UNPREFIXED
  // CAMPUS_WRITE_PERMISSION) → resolve CampusScope → load the CARD → per-card campus
  // scope on the card's OWN campusId (a Campus Admin cannot touch another campus's card,
  // Pitfall 6). Card status is FULLY INDEPENDENT of the ordination credential: voiding a
  // card NEVER touches personOrdination (Pitfall 5 — the "also revoke" prompt is deferred).

  // Void an issued card (LOCKED: reason required). Sets status "void" + writes an
  // append-only AuditLogHelper row (who/when/reason). Does NOT re-render or archive, and
  // NEVER calls repos.personOrdination.* — the credential is provably untouched.
  @httpPost("/:id/void")
  public async voidCard(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      const scope = await CampusScopeHelper.resolve(au, this.repos);
      const card = await this.repos.licenseCard.load(au.churchId, id);
      if (!card?.id) return this.json({}, 404);
      if (!assertWritableCampus(scope, card.campusId)) return this.json({}, 401);

      // LOCKED: a non-empty reason is required (422 otherwise). The client sends either a
      // preset code or free-text "Other"; the server simply stores the non-empty string
      // (preset-vs-freetext UX lives in 07-06).
      const reason = ((req.body?.reason as string) || "").trim();
      if (!reason) return this.json({ error: "reason_required" }, 422);

      await this.repos.licenseCard.updateStatus(au.churchId, id, "void", {
        voidReason: reason,
        voidedBy: au.id
      });

      // Append-only, attributable audit row (who/when/reason). The credential is untouched.
      await AuditLogHelper.log(
        this.repos, au.churchId, au.id, "license", "card_voided", "licenseCard", id,
        { reason }, AuditLogHelper.getClientIp(req)
      );

      return this.repos.licenseCard.load(au.churchId, id);
    });
  }

  // Mark a card printed (+ printedAt). Called by the print-station on the download-confirm
  // "Did they print OK?" path (mark-printed on download, then confirm voids jams). Audited.
  @httpPost("/:id/markPrinted")
  public async markPrinted(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      const scope = await CampusScopeHelper.resolve(au, this.repos);
      const card = await this.repos.licenseCard.load(au.churchId, id);
      if (!card?.id) return this.json({}, 404);
      if (!assertWritableCampus(scope, card.campusId)) return this.json({}, 401);

      await this.repos.licenseCard.updateStatus(au.churchId, id, "printed", { printedAt: new Date() });

      await AuditLogHelper.log(
        this.repos, au.churchId, au.id, "license", "card_printed", "licenseCard", id,
        {}, AuditLogHelper.getClientIp(req)
      );

      return this.repos.licenseCard.load(au.churchId, id);
    });
  }
}
