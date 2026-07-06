// PRT-06 — the CR80 dimension guard.
//
// Chromium's page.pdf SILENTLY scales content onto US-Letter unless preferCSSPageSize:true
// is set (06-03 renderPdf). This test renders a real fixture card through the full
// buildHtml → renderPdf pipeline and asserts the resulting PDF's MediaBox equals the CR80
// trim (85.6mm × 53.98mm) within ±1pt. If preferCSSPageSize ever regresses, the MediaBox
// jumps to Letter (612×792pt) and this test — wired into CI in test.yml — fails the build.
//
// Skip policy: this test only SKIPS when Chromium is genuinely unlaunchable in the run
// environment (local machine with no browser). It NEVER silently passes on a wrong size —
// a scaling regression produces a resolvable browser and a failing assertion.

import { PDFDocument } from "pdf-lib";

// renderFonts.ts locates its bundled woff2 dir via `import.meta.url`, which the Jest
// CommonJS transform can't parse (SyntaxError: import.meta outside a module). The MediaBox
// this test asserts comes purely from the @page CSS and is independent of @font-face, so we
// stub the font-CSS builder to keep the pipeline loadable under Jest. (CI in test.yml runs
// the SAME assertion — page geometry is what PRT-06 guards, not embedded font bytes.)
jest.mock("../renderFonts.js", () => ({ buildFontFaceCss: () => "" }));

import {
  LicenseRenderHelper,
  closeSharedBrowser,
  getSharedBrowser,
  type LicenseTemplateLayout,
} from "../LicenseRenderHelper.js";

// CR80 trim in PostScript points: mm × 72 / 25.4.
const CR80_WIDTH_PT = (85.6 * 72) / 25.4; // 242.6457
const CR80_HEIGHT_PT = (53.98 * 72) / 25.4; // 153.0142

// Minimal, self-contained fixture: CR80 canvas (bleed 2 / safe 3) with a single staticText
// element. No image assets, so the render needs no FileStorage/disk.
const fixtureLayout = (): LicenseTemplateLayout => ({
  schemaVersion: 1,
  canvas: {
    trimWidthMm: 85.6,
    trimHeightMm: 53.98,
    bleedMm: 2,
    safeMm: 3,
    widthMm: 85.6 + 2 * 2,
    heightMm: 53.98 + 2 * 2,
  },
  elements: [
    {
      id: "t1",
      type: "staticText",
      z: 1,
      xMm: 6,
      yMm: 6,
      wMm: 60,
      hMm: 10,
      text: "MINISTERIAL LICENSE",
      font: { family: "sans", sizePt: 10, weight: 700, color: "#000000", align: "left" },
    },
  ],
});

describe("LicenseRenderHelper.renderPdf — PRT-06 CR80 MediaBox guard", () => {
  let chromiumAvailable = true;

  beforeAll(async () => {
    // Probe once: if Chromium genuinely cannot launch here, mark the suite to skip its
    // body (rather than fail) — CI (test.yml) installs Chromium so the guard runs there.
    try {
      await getSharedBrowser();
    } catch (err) {
      chromiumAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `[PRT-06] Skipping MediaBox assertion — Chromium unavailable in this environment: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }, 60000);

  afterAll(async () => {
    await closeSharedBrowser();
  });

  it("produces a PDF whose page size equals the CR80 trim within ±1pt", async () => {
    if (!chromiumAvailable) {
      // eslint-disable-next-line no-console
      console.warn("[PRT-06] Chromium unavailable — assertion skipped (see test.yml CI gate).");
      return;
    }

    const html = LicenseRenderHelper.buildHtml(fixtureLayout(), {}, LicenseRenderHelper.NO_CALIBRATION);
    const bytes = await LicenseRenderHelper.renderPdf(html);

    // Sanity: a real PDF came back.
    expect(bytes.length).toBeGreaterThan(500);

    const doc = await PDFDocument.load(bytes);
    const { width, height } = doc.getPage(0).getMediaBox();

    // toBeCloseTo(x, 0) → |actual - x| < 0.5pt. Chromium quantizes at ~0.2mm (≈0.57pt);
    // a genuine "scale-to-fit-Letter" regression is ≥3pt off and fails here (Pitfall 6).
    expect(width).toBeCloseTo(CR80_WIDTH_PT, 0); // 242.6457pt (85.6mm)
    expect(height).toBeCloseTo(CR80_HEIGHT_PT, 0); // 153.0142pt (53.98mm)
  }, 60000);
});
