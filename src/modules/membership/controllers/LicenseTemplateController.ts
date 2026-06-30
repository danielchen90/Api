import { controller, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { FileStorageHelper, UniqueIdHelper } from "@churchapps/apihelper";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { CAMPUS_WRITE_PERMISSION, CAMPUS_ORGWIDE_MARKER } from "../helpers/index.js";
import { LicenseTemplate } from "../models/index.js";

/**
 * License-card template API (TPL-01/TPL-03/TPL-04).
 *
 * Templates are CHURCH-WIDE vocabulary, NOT campus-scoped (the licenseTemplates table has no
 * campusId; LicenseTemplateRepo has no applyCampusScope — see 05-01 / RESEARCH Open Q2). Hence
 * reads are auth-only church-scoped and writes are NOT routed through assertWritableCampus —
 * exactly the OrdinationTypeController posture.
 *
 * WRITE GATE — Leadership-Admin-ONLY (the DUAL gate, identical to OrdinationTypeController): a write
 * requires BOTH au.checkAccess(CAMPUS_WRITE_PERMISSION) AND au.checkAccess(CAMPUS_ORGWIDE_MARKER).
 * Each alone is insufficient — the marker ALONE = org-wide but read-only Reporter holds it;
 * CAMPUS_WRITE_PERMISSION ALONE = a campus-scoped Campus Admin who must NOT edit church-wide
 * vocabulary. Requiring both pins template management to Leadership Admin (RESEARCH Pitfall 6 / Q2).
 *
 * SAVE ROUTING — `const isNew = !item.id` is captured at the TOP of save(), BEFORE image storage
 * pre-assigns item.id. That isNew flag is the SOLE authority for create-vs-update AND the 200-vs-409
 * decision — routing is NEVER re-derived from item.id after storage assigns one. A brand-new template
 * carrying embedded data-URL images therefore still routes to create (05-01 Pitfall context).
 *
 * IMAGE STORAGE — data-URL images in layoutJson (named background slot + image elements) are stored
 * out into FileStorage (mirroring PersonController.savePhoto) and replaced with stored refs BEFORE
 * persistence, so the v1 snapshot 05-01 freezes on create holds refs only (RESEARCH Pitfall 8).
 *
 * OCC / UNIQUENESS — a stale `version` update returns 0n → 409 { error: "version_conflict" }; a
 * defaultFlag / activeFlag unique-index collision (MySQL ER_DUP_ENTRY, errno 1062) is surfaced as a
 * DISTINCT 409 (duplicate_default / duplicate_active_type) so the UI can explain which constraint
 * fired (mirror PersonOrdinationController's duplicate_active mapping).
 */
@controller("/membership/licenseTemplates")
export class LicenseTemplateController extends MembershipBaseController {

  // MySQL duplicate-key on a partial-unique index (defaultFlag or activeFlag).
  private isDuplicate(err: any): boolean {
    return err?.code === "ER_DUP_ENTRY" || err?.errno === 1062;
  }

  // Distinguish WHICH unique index collided so the UI can explain the conflict precisely.
  private duplicateError(err: any): string {
    const msg = (err?.sqlMessage || err?.message || "") as string;
    if (msg.includes("uq_licenseTemplates_default")) return "duplicate_default";
    return "duplicate_active_type";
  }

  /**
   * Store any data-URL images embedded in layoutJson out into FileStorage and replace them with
   * stored refs, mirroring PersonController.savePhoto. Runs BEFORE persistence so the v1 snapshot
   * 05-01 freezes on create contains REFS ONLY, never base64 (RESEARCH Pitfall 8).
   *
   * Slots handled: the named `background` slot and every `image`-type element (logo). `photo`-type
   * placeholders carry NO src (the region is filled in Phase 4/6) and are skipped. Already-stored
   * keys (not starting with "data:image/") pass through untouched, so a re-save is idempotent.
   *
   * The caller pre-assigns a stable templateId (item.id) so the key path is fixed for a brand-new
   * template; layoutJson is parsed (it may arrive as a string or an object), mutated in place, then
   * re-stringified back onto item.layoutJson.
   */
  private async storeLayoutImages(churchId: string, templateId: string, item: LicenseTemplate): Promise<void> {
    if (!item.layoutJson) return;
    const layout: any = typeof item.layoutJson === "string" ? JSON.parse(item.layoutJson) : item.layoutJson;

    const storeSlot = async (src: string, slotId: string): Promise<string> => {
      const key = "/" + churchId + "/membership/licenseTemplates/" + templateId + "/" + slotId + ".png";
      const base64 = src.split(",")[1];
      await FileStorageHelper.store(key, "image/png", Buffer.from(base64, "base64"));
      return key + "?dt=" + Date.now(); // cache-bust
    };

    // Background slot.
    if (typeof layout?.background?.src === "string" && layout.background.src.startsWith("data:image/")) {
      layout.background.src = await storeSlot(layout.background.src, "background");
    }

    // Image elements (logos). photo-placeholders have no src and pass through.
    const elements: any[] = Array.isArray(layout?.elements) ? layout.elements : [];
    for (const el of elements) {
      if (el?.type === "image" && typeof el.src === "string" && el.src.startsWith("data:image/")) {
        el.src = await storeSlot(el.src, el.id);
      }
    }

    // Persist ONLY refs back into layoutJson — never base64.
    item.layoutJson = JSON.stringify(layout);
  }

  // ── Reads: auth-only, church-scoped (any settings user may VIEW; not write-gated) ──

  // List a church's non-removed templates (editor's template picker).
  @httpGet("/")
  public async getAll(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      return this.repos.licenseTemplate.loadAll(au.churchId);
    });
  }

  // Load one template by id; 404-empty when missing/removed.
  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const template = await this.repos.licenseTemplate.load(au.churchId, id);
      if (!template) return this.json({}, 404);
      return template;
    });
  }

  // Audit version history for the editor's version list (TPL-03). Phase 6 reproduce uses loadVersion.
  @httpGet("/:id/versions")
  public async getVersions(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      return this.repos.licenseTemplate.loadVersions(au.churchId, id);
    });
  }

  // ── Save (create / edit) — dual-gated, image storage, version snapshot, OCC → 409 ──
  @httpPost("/")
  public async save(req: express.Request<{}, {}, LicenseTemplate>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // 1. DUAL WRITE GATE (Leadership-Admin-only) — both the Edit capability AND the org-wide marker.
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION) || !au.checkAccess(CAMPUS_ORGWIDE_MARKER)) return this.json({}, 401);

      // 2. Accept a SINGLE template object (the editor saves one template at a time).
      const item = req.body as LicenseTemplate;

      // 3. CAPTURE new-vs-existing FIRST — BEFORE image storage pre-assigns item.id. This flag is the
      //    SOLE authority for create-vs-update routing AND the 200-vs-409 decision; routing is NEVER
      //    re-derived from item.id after storage assigns one.
      const isNew = !item.id;

      // 4. Server-derive tenancy/attribution — NEVER trust the body's churchId.
      item.churchId = au.churchId;
      item.updatedBy = au.id;
      if (isNew) item.createdBy = au.id;

      // 5. IMAGE STORAGE — store data-URL images out of layoutJson into FileStorage and replace
      //    them with refs BEFORE persistence, so the v1 snapshot 05-01 freezes on create holds refs
      //    only (RESEARCH Pitfall 8). Pre-assign a STABLE id for the storage key path when new
      //    (05-01 create() respects this id and never overwrites it); routing was ALREADY decided by
      //    isNew above, so the now-present id does NOT change create-vs-update.
      if (isNew) item.id = UniqueIdHelper.shortId();
      await this.storeLayoutImages(au.churchId, item.id, item);

      // 6. Persist by the EXPLICIT isNew flag (NEVER item.id, which is now present even for new rows).
      try {
        if (isNew) {
          // create path — 05-01 create() respects the pre-assigned id and writes the v1 snapshot.
          await this.repos.licenseTemplate.save(item, true);
          return this.repos.licenseTemplate.load(au.churchId, item.id);
        } else {
          // update path — returns numUpdatedRows; 0n = stale version → 409 version_conflict.
          const n = await this.repos.licenseTemplate.save(item, false);
          if (n === 0n) return this.json({ error: "version_conflict" }, 409);
          return this.repos.licenseTemplate.load(au.churchId, item.id);
        }
      } catch (err: any) {
        // defaultFlag / activeFlag unique-index collision → distinct 409.
        if (this.isDuplicate(err)) return this.json({ error: this.duplicateError(err) }, 409);
        throw err;
      }
    });
  }

  // ── Soft delete — same dual gate; version-guarded (stale version → 409) ──
  @httpPost("/:id/delete")
  public async softDelete(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION) || !au.checkAccess(CAMPUS_ORGWIDE_MARKER)) return this.json({}, 401);
      const version = (req.body as any)?.version as number;
      const n = await this.repos.licenseTemplate.softDelete(au.churchId, id, version, au.id);
      if (n === 0n) return this.json({ error: "version_conflict" }, 409);
      return this.json({}, 200);
    });
  }
}
