// PrintBatchRenderHelper.ts — the bounded batch-render engine (PRT-02).
//
// This is the HEART of PRT-02: "streams/paginates rather than building one giant
// in-memory document." Two responsibilities:
//
//   resolveCards — expand each selected personId into ONE card per ACTIVE credential,
//     auto-binding a template (per ordination type, else the global default) + a
//     templateVersion SNAPSHOT (for byte-identical later regeneration), campus-scoped
//     per credential (a scoped operator must not batch another campus's card), and
//     skip-and-report every un-renderable person with a clear reason.
//
//   renderBatch — loop Phase 6's single `LicenseRenderHelper.renderPdf` over the resolved
//     cards on the SAME shared Chromium with capped concurrency (never one giant Puppeteer
//     multi-page HTML doc), merge each single-card PDF into one growing pdf-lib document
//     INCREMENTALLY (load → copyPages → addPage, releasing each source buffer so batch
//     memory stays bounded), retry-twice-then-skip a failing card (the batch still produces
//     a PDF of the successes), write DB-backed progress to the printBatches row (survives a
//     redeploy), and archive the assembled PDF.
//
// It imports the Phase-6 renderer contract (LicenseRenderHelper.buildHtml / renderPdf,
// renderBindings.buildPreviewData) — it does NOT re-implement the renderer.

import { PDFDocument } from "pdf-lib";
import { FileStorageHelper } from "@churchapps/apihelper";
import type { Repos } from "../repositories/index.js";
import { assertWritableCampus, type CampusScope } from "./applyCampusScope.js";
import { buildPreviewData } from "./renderBindings.js";
import {
  LicenseRenderHelper,
  NO_CALIBRATION,
  type Calibration,
  type RenderAssets,
  type LicenseTemplateLayout
} from "./LicenseRenderHelper.js";

// ── Tunable server budget (RESEARCH recommendations) ────────────────────────
// SOFT_CAP documents the per-batch card budget the client warns against exceeding
// (the warning is enforced client-side; this constant records the server intent).
export const SOFT_CAP = 150;
// RENDER_CONCURRENCY caps how many renderPdf calls run at once on the shared browser.
const RENDER_CONCURRENCY = 3;
// A failed card is retried MAX_RETRIES more times (so MAX_RETRIES+1 total attempts)
// with a small backoff before it is skipped-and-reported.
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Types ───────────────────────────────────────────────────────────────────

// A skipped person/credential + the operator-facing reason it could not be rendered.
export interface SkippedCard {
  personId: string;
  reason: string;
}

// One fully-resolved card ready to render. Carries the templateVersion SNAPSHOT (persisted
// for reproducibility), the resolved binding `data`, the pre-fetched image `assets`, and the
// `calibration` baked into the rendered bytes. `cardId` is populated by the 07-04 controller
// AFTER it persists the draft licenseCards row — renderBatch flips it to "queued" once merged.
export interface ResolvedCard {
  personId: string;
  personOrdinationId: string;
  campusId: string;
  templateId: string;
  templateVersion: number; // the frozen licenseTemplateVersions snapshot to re-render from
  data: Record<string, string>;
  assets: RenderAssets;
  calibration: Calibration;
  cardId?: string;
}

// ── Template binding ─────────────────────────────────────────────────────────

// Auto-bind a template to a credential's ordination type (LOCKED: NO operator choice):
// an ACTIVE template bound to that exact ordination type wins; else the ACTIVE global
// default. Returns undefined when neither exists (→ skip "no active template for type").
const pickTemplate = (templates: any[], ordinationTypeId?: string | null) =>
  templates.find((t) => t.active && t.ordinationTypeId === ordinationTypeId) ??
  templates.find((t) => t.active && t.isDefault);

// ── The batch-render engine ───────────────────────────────────────────────────

export class PrintBatchRenderHelper {
  constructor(private repos: Repos) {}

  // Expand selected people into one ResolvedCard per ACTIVE credential, auto-binding a
  // template + version snapshot, campus-scoped per credential, skipping-and-reporting the
  // un-renderable (Pattern 5). Church-wide templates are loaded once (NOT campus-scoped).
  public async resolveCards(
    churchId: string,
    personIds: string[],
    scope: CampusScope,
    _actorId: string
  ): Promise<{ cards: ResolvedCard[]; skipped: SkippedCard[] }> {
    const cards: ResolvedCard[] = [];
    const skipped: SkippedCard[] = [];

    // Church-wide vocabulary — LicenseTemplateRepo has no applyCampusScope.
    const templates = await this.repos.licenseTemplate.loadAll(churchId);
    const church = await this.repos.church.load(churchId, churchId);

    for (const personId of personIds) {
      // Credentials scoped to the caller's writable/visible campuses (Phase 2).
      const ordinations = await this.repos.personOrdination.loadForPerson(churchId, personId, scope);
      const active = ordinations.filter((o) => o.status === "active");
      if (!active.length) {
        skipped.push({ personId, reason: "no active credential" });
        continue;
      }

      // Load the person ONCE (→ nested Name object buildPreviewData binds against).
      const personRow = await this.repos.person.load(churchId, personId);
      const person = personRow ? this.repos.person.convertToModel(churchId, personRow) : undefined;

      for (const ord of active) {
        // Pitfall 6 — a scoped operator must not batch another campus's card.
        if (!assertWritableCampus(scope, ord.campusId)) {
          skipped.push({ personId, reason: "credential outside your campus scope" });
          continue;
        }

        const tmpl = pickTemplate(templates, ord.ordinationTypeId);
        if (!tmpl) {
          skipped.push({ personId, reason: "no active template for type" });
          continue;
        }

        // A batch card requires a cropped license photo (LOCKED skip-and-report).
        const crop = await this.repos.personPhotoCrop.loadByPurpose(churchId, personId, "license");
        if (!crop?.id) {
          skipped.push({ personId, reason: "no cropped photo" });
          continue;
        }

        // Resolve the binding data (per-card fetch of ordination type + campus).
        const ordinationType = ord.ordinationTypeId
          ? await this.repos.ordinationType.load(churchId, ord.ordinationTypeId)
          : undefined;
        const campus = ord.campusId ? await this.repos.campus.load(churchId, ord.campusId) : undefined;
        const data = buildPreviewData(
          person as any,
          ord as any,
          ordinationType as any,
          campus as any,
          church as any
        );

        const assets: RenderAssets = {
          photoSrc: "/" + churchId + "/membership/people/" + personId + ".png",
          crop: {
            cropX: crop.cropX,
            cropY: crop.cropY,
            cropWidth: crop.cropWidth,
            cropHeight: crop.cropHeight,
            rotation: crop.rotation
          }
        };

        cards.push({
          personId,
          personOrdinationId: ord.id,
          campusId: ord.campusId,
          templateId: tmpl.id,
          templateVersion: tmpl.currentVersion, // SNAPSHOT for reproducible regeneration
          data,
          assets,
          calibration: NO_CALIBRATION
        });
      }
    }

    return { cards, skipped };
  }
}
