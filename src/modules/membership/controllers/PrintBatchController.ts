import { controller, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import fs from "fs";
import path from "path";
import { MembershipBaseController } from "./MembershipBaseController.js";
import {
  CampusScopeHelper,
  assertWritableCampus,
  CAMPUS_WRITE_PERMISSION,
  AuditLogHelper
} from "../helpers/index.js";
import { buildPreviewData } from "../helpers/renderBindings.js";
import { NO_CALIBRATION, type RenderAssets } from "../helpers/LicenseRenderHelper.js";
import { PrintBatchRenderHelper, type ResolvedCard } from "../helpers/PrintBatchRenderHelper.js";
import { LicenseCard } from "../models/index.js";

/**
 * Print-batch API (PRT-02 + PRT-04 read/bulk surface) — the DB-backed async job +
 * polling surface over PrintBatchRenderHelper.
 *
 *   POST /                — resolve the card set, persist the printBatches row + draft
 *                           licenseCards rows (reproducibility record) BEFORE returning,
 *                           fire-and-forget the render (NOT awaited — the client polls),
 *                           and return { batchId, cardCount, skipped } immediately.
 *   GET  /:id             — poll-able DB-backed batch state (status/renderedCount/pdfRef).
 *   GET  /                — church-scoped recent batches for the kiosk recent-batches picker.
 *   GET  /:id/cards       — THE enriched, campus-filtered per-card list (cardId + person/
 *                           credential/campus/status) that drives 07-06's per-card status list
 *                           + the cardIds its reprint/void act on. Page-aligned (loadByBatch
 *                           createdAt asc == assembled-PDF page order).
 *   GET  /:id/pdf         — stream the assembled multi-page PDF bytes from disk.
 *   POST /:id/markPrinted — BULK-mark every non-void card in the batch printed in ONE audited
 *                           round-trip (avoids ~150 sequential per-card POSTs on download-confirm).
 *   POST /:id/regenerate  — re-render the SAME linked cards at their STORED templateVersions →
 *                           byte-identical historical PDF (audit-grade reproducibility).
 *
 * CAMPUS SCOPE: batch creation and every read/write are campus-scoped. resolveCards enforces
 * per-credential scope at create time; /cards, /markPrinted, and /regenerate re-filter each
 * card against the operator's writable campuses (a Campus Admin never sees, marks, or
 * regenerates another campus's cards even inside a church-scoped batch — Pitfall 6). The
 * write-capability gate (CAMPUS_WRITE_PERMISSION, UNPREFIXED per the campus-auth memory)
 * precedes the scope gate on every write.
 *
 * CLIENT-PATH NOTE: the MembershipApi base already ends in /membership, so the CLIENT calls
 * the BARE /printBatches path. The @controller decorator still uses the full server mount.
 */
@controller("/membership/printBatches")
export class PrintBatchController extends MembershipBaseController {

  // Rebuild a full ResolvedCard from a STORED licenseCards row for a byte-identical
  // historical re-render: the frozen personOrdinationId/templateId/templateVersion drive
  // the render (never a re-pick), while the binding data + photo assets are re-fetched live
  // (exactly the shape resolveCards/reprint build). renderBatch consumes card.data/card.assets
  // directly, so regenerate MUST reconstruct them here.
  private async resolvedCardFromRow(churchId: string, row: LicenseCard, scope: any): Promise<ResolvedCard | null> {
    const ordination = await this.repos.personOrdination.load(churchId, row.personOrdinationId, scope);
    if (!ordination?.id) return null;

    const personRow = await this.repos.person.load(churchId, ordination.personId);
    const person = personRow ? this.repos.person.convertToModel(churchId, personRow) : undefined;
    const ordinationType = ordination.ordinationTypeId
      ? await this.repos.ordinationType.load(churchId, ordination.ordinationTypeId)
      : undefined;
    const campus = ordination.campusId ? await this.repos.campus.load(churchId, ordination.campusId) : undefined;
    const church = await this.repos.church.load(churchId, churchId);
    const data = buildPreviewData(person as any, ordination as any, ordinationType as any, campus as any, church as any);

    const assets: RenderAssets = {};
    if ((person as any)?.photoUpdated) {
      assets.photoSrc = "/" + churchId + "/membership/people/" + ordination.personId + ".png";
      const crop = await this.repos.personPhotoCrop.loadByPurpose(churchId, ordination.personId, "license");
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

    return {
      personId: row.personId,
      personOrdinationId: row.personOrdinationId,
      campusId: row.campusId,
      templateId: row.templateId,
      templateVersion: row.templateVersion, // STORED snapshot — reproducible, not the live version
      data,
      assets,
      calibration: NO_CALIBRATION,
      cardId: row.id
    };
  }

  // ── POST / — resolve + persist draft rows + fire-and-forget render, return batchId ──
  //
  // Persists the batch + a draft licenseCards row per resolved card (the reproducibility
  // record) BEFORE returning, kicks off the render UNAWAITED (the client polls GET /:id),
  // and returns { batchId, cardCount, skipped } immediately.
  @httpPost("/")
  public async create(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // 1. WRITE-CAPABILITY GATE first (UNPREFIXED constant — read-only roles 401).
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      const scope = await CampusScopeHelper.resolve(au, this.repos);
      const { personIds, filterJson, name, templateId, ordinationTypeIds } = req.body as {
        personIds?: string[];
        filterJson?: unknown;
        name?: string;
        templateId?: string; // OPTIONAL operator override: force ALL cards onto this one
        //                       template (e.g. a certificate); absent => auto-pick per type.
        ordinationTypeIds?: string[]; // OPTIONAL credential-type restriction: print ONLY these
        //                       credential types; absent/empty => one card per active credential.
      };

      // 2. Resolve the card set (per-credential campus scope enforced inside — Pattern 5).
      const renderHelper = new PrintBatchRenderHelper(this.repos);
      const { cards, skipped } = await renderHelper.resolveCards(au.churchId, personIds ?? [], scope, au.id, templateId, ordinationTypeIds);

      // 3. Persist the batch (provenance filterJson stored alongside the resolved cards).
      const batch = await this.repos.printBatch.save({
        churchId: au.churchId,
        name,
        filterJson: typeof filterJson === "string" ? filterJson : JSON.stringify(filterJson ?? null),
        status: "rendering",
        cardCount: cards.length,
        renderedCount: 0,
        createdBy: au.id,
        createdAt: new Date()
      });

      // 4. Persist the reproducibility record BEFORE returning: a draft licenseCards row per
      //    card (in card order → loadByBatch createdAt asc later matches the PDF page order).
      //    Stamp the resulting cardId back onto the ResolvedCard so renderBatch can flip it
      //    to "queued" as each card merges.
      for (const card of cards) {
        const saved = await this.repos.licenseCard.save({
          churchId: au.churchId,
          personId: card.personId,
          personOrdinationId: card.personOrdinationId,
          campusId: card.campusId,
          templateId: card.templateId,
          templateVersion: card.templateVersion,
          batchId: batch.id,
          status: "draft",
          createdBy: au.id,
          createdAt: new Date()
        });
        card.cardId = saved.id;
      }

      // 5. FIRE-AND-FORGET the render (do NOT await — the client polls). Any escape routes
      //    the batch to a terminal failed status so a DB-backed poller never hangs.
      renderHelper
        .renderBatch(au.churchId, batch.id, cards, au.id)
        .catch((e) => this.repos.printBatch.fail(au.churchId, batch.id, e));

      // 6. Return immediately — the skipped list surfaces un-renderable people right away.
      return { batchId: batch.id, cardCount: cards.length, skipped };
    });
  }

  // ── GET / — recent batches (church-scoped) for the kiosk recent-batches picker ──
  //
  // Declared BEFORE GET /:id so the bare-list route is not shadowed by the :id param route.
  // Batches are church-scoped rows; per-card campusId scope is enforced at resolve/list-cards/
  // reprint/void/regenerate time.
  @httpGet("/")
  public async list(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      await CampusScopeHelper.resolve(au, this.repos);
      return this.repos.printBatch.loadRecent(au.churchId);
    });
  }

  // ── GET /:id — poll-able DB-backed batch state ──
  //
  // Light on purpose (batch row only — the per-card list lives on /:id/cards). React Query
  // polls this until status !== "rendering".
  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      await CampusScopeHelper.resolve(au, this.repos);
      return this.repos.printBatch.load(au.churchId, id);
    });
  }

  // ── GET /:id/pdf — stream the assembled multi-page PDF bytes from disk ──
  //
  // FileStorageHelper has NO read method (verified .d.ts), so the archived PDF is read back
  // from disk (mirror the Phase-6 photo disk-read pattern). The client does fetch→blob→objectURL
  // (ApiHelper cannot return bytes). Strip any ?dt= cache-buster before resolving the path.
  @httpGet("/:id/pdf")
  public async pdf(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      await CampusScopeHelper.resolve(au, this.repos);
      const batch = await this.repos.printBatch.load(au.churchId, id);
      if (!batch?.id) return this.json({ error: "not_found" }, 404);
      if (batch.status !== "ready" || !batch.pdfRef) return this.json({ error: "not_ready" }, 409);

      const buf = fs.readFileSync(path.resolve("./content") + batch.pdfRef.replace(/\?.*$/, ""));
      res.setHeader("Content-Type", "application/pdf");
      return res.send(buf);
    });
  }

  // ── POST /:id/regenerate — byte-identical historical re-render at STORED versions ──
  //
  // Re-renders the SAME linked cards at their STORED templateVersions (via loadVersion inside
  // renderBatch) → byte-identical to the ORIGINAL TEMPLATE regardless of later template edits
  // (LOCKED audit-grade "exact PDF" — Success Criterion 2). Each card is re-checked against the
  // operator's writable campuses; the binding data + photo assets are re-fetched live.
  @httpPost("/:id/regenerate")
  public async regenerate(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      const scope = await CampusScopeHelper.resolve(au, this.repos);
      const batch = await this.repos.printBatch.load(au.churchId, id);
      if (!batch?.id) return this.json({ error: "not_found" }, 404);

      // Rebuild each ResolvedCard from the STORED row, re-checking per-card campus scope.
      const rows = await this.repos.licenseCard.loadByBatch(au.churchId, id);
      const cards: ResolvedCard[] = [];
      for (const row of rows) {
        if (!assertWritableCampus(scope, row.campusId)) continue;
        const card = await this.resolvedCardFromRow(au.churchId, row, scope);
        if (card) cards.push(card);
      }

      // Reset the batch to rendering/0 and fire the re-render (unawaited — the client polls).
      await this.repos.printBatch.finish(au.churchId, id, { status: "rendering" });
      await this.repos.printBatch.updateProgress(au.churchId, id, 0);

      const renderHelper = new PrintBatchRenderHelper(this.repos);
      renderHelper
        .renderBatch(au.churchId, id, cards, au.id)
        .catch((e) => this.repos.printBatch.fail(au.churchId, id, e));

      return { batchId: id };
    });
  }

  // ── GET /:id/cards — the enriched, campus-filtered per-card list ──
  //
  // THE data source for 07-06's per-card status list + the cardIds its reprint/void act on —
  // WITHOUT it the per-card UI can never obtain a cardId. Campus-filtered (a Campus Admin sees
  // ONLY their campus's cards even inside a church-scoped batch — Pitfall 6). Returned in
  // loadByBatch order (createdAt asc == assembled-PDF page order) so 07-06 can align
  // thumbnail[i] ↔ card[i].
  @httpGet("/:id/cards")
  public async cards(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await CampusScopeHelper.resolve(au, this.repos);
      const rows = await this.repos.licenseCard.loadByBatch(au.churchId, id);

      const church = await this.repos.church.load(au.churchId, au.churchId);
      const out: any[] = [];
      for (const row of rows) {
        // Campus-filter: keep only the operator's writable cards.
        if (!assertWritableCampus(scope, row.campusId)) continue;

        // Enrich each row for display, reusing the same repos resolveCards gathers from.
        const personRow = await this.repos.person.load(au.churchId, row.personId);
        const person = personRow ? this.repos.person.convertToModel(au.churchId, personRow) : undefined;
        const personName =
          (person as any)?.name?.display ||
          [(person as any)?.name?.first, (person as any)?.name?.last].filter(Boolean).join(" ") ||
          "";

        const ordination = row.personOrdinationId
          ? await this.repos.personOrdination.load(au.churchId, row.personOrdinationId, scope)
          : undefined;
        const ordinationType = ordination?.ordinationTypeId
          ? await this.repos.ordinationType.load(au.churchId, ordination.ordinationTypeId)
          : undefined;
        const campus = row.campusId ? await this.repos.campus.load(au.churchId, row.campusId) : undefined;

        out.push({
          cardId: row.id,
          personId: row.personId,
          personName,
          credentialType: (ordinationType as any)?.name ?? "",
          credentialNumber: (ordination as any)?.credentialNumber ?? "",
          campusId: row.campusId,
          campusName: (campus as any)?.name ?? "",
          status: row.status,
          printedAt: row.printedAt,
          voidReason: row.voidReason
        });
      }
      void church; // church loaded once to mirror resolveCards' fetch shape (reserved for future fields)
      return out;
    });
  }

  // ── POST /:id/markPrinted — BULK mark every non-void writable card printed ──
  //
  // The download-confirm "Did they print OK?" action (LOCKED auto-mark-on-download). Collapsing
  // it to ONE round-trip + ONE audit row avoids ~150 sequential per-card POSTs for a soft-cap
  // batch. NEVER touches personOrdination — card status is independent of the credential
  // (Pitfall 5). Distinct mount from the per-card POST /licenseCards/:id/markPrinted (07-03).
  @httpPost("/:id/markPrinted")
  public async markPrinted(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      const scope = await CampusScopeHelper.resolve(au, this.repos);
      const rows = await this.repos.licenseCard.loadByBatch(au.churchId, id);

      let count = 0;
      for (const row of rows) {
        if (!assertWritableCampus(scope, row.campusId)) continue;
        if (row.status === "void") continue;
        await this.repos.licenseCard.updateStatus(au.churchId, row.id, "printed", { printedAt: new Date() });
        count++;
      }

      // ONE append-only audit row for the whole batch action.
      await AuditLogHelper.log(
        this.repos, au.churchId, au.id, "license", "batch_printed", "printBatch", id,
        { count }, AuditLogHelper.getClientIp(req)
      );

      return { printed: count };
    });
  }
}
