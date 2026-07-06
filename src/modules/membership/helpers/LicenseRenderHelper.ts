// LicenseRenderHelper.ts — the PURE HTML-generation core of the license-card renderer.
//
// Reproduces the Phase 5 editor's CanvasElement.renderByType + Canvas.tsx card wrapper
// (forks/B1Admin/src/licenseTemplates/editor/*) in NATIVE CSS mm/pt — NO PX_PER_MM, NO
// ptToPx. Headless Chromium (added in 06-03) turns this HTML into an EXACT-CR80 PDF via
// `@page { size: 85.6mm 53.98mm; margin: 0 }` + `preferCSSPageSize:true`, so the printed
// card is byte-faithful to the editor preview (RESEARCH §Architecture Pattern 1).
//
// The pure string builders (buildHtml/buildTestCardHtml) stay Puppeteer-FREE. renderPdf
// (added in 06-03) is the ONE Puppeteer boundary: it drives a SHARED headless Chromium
// (never a per-render cold launch — RESEARCH Pitfall 1) and calls page.pdf with the exact
// CR80 options that make Chromium honor the @page verbatim.
// The 06-04 controller does the DB/FileStorage fetching and passes bytes in via `assets`.

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import type { Browser } from "puppeteer";
import { buildFontFaceCss } from "./renderFonts.js";
import { resolveBinding } from "./renderBindings.js";

// ---------------------------------------------------------------------------
// LOCAL LAYOUT CONTRACT — KEEP IN SYNC WITH forks/B1Admin/src/licenseTemplates/
// LicenseTemplateInterface.ts ("KEEP IN SYNC WITH PHASE 6 RENDERER"). This is the
// declarative layout the renderer consumes; geometry is mm, font size is pt, NO px.
// ---------------------------------------------------------------------------
export interface LicenseTemplateLayout {
  schemaVersion: 1;
  canvas: {
    trimWidthMm: number; // 85.6 (CR80 trim)
    trimHeightMm: number; // 53.98
    bleedMm: number;
    safeMm: number;
    widthMm: number; // trim + 2*bleed (full bleed box)
    heightMm: number;
  };
  background?: { src: string; fit: "cover" | "contain" };
  elements: LayoutElement[];
}

export type LayoutElement =
  | BoundTextElement
  | StaticTextElement
  | ImageElement
  | PhotoPlaceholderElement;

export interface ElementBase {
  id: string;
  z: number;
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

export interface TextStyle {
  family: string; // whitelist KEY (sans/serif/condensed/mono)
  sizePt: number; // points (print-native)
  weight: 400 | 700;
  color: string; // #RRGGBB
  align: "left" | "center" | "right";
  lineHeight?: number;
}

export interface BoundTextElement extends ElementBase {
  type: "boundText";
  binding: string;
  prefix?: string;
  suffix?: string;
  dateFormat?: string;
  fallback?: string;
  font: TextStyle;
}

export interface StaticTextElement extends ElementBase {
  type: "staticText";
  text: string;
  font: TextStyle;
}

export interface ImageElement extends ElementBase {
  type: "image";
  src: string;
  fit: "contain" | "cover";
}

export interface PhotoPlaceholderElement extends ElementBase {
  type: "photo";
  fit: "cover" | "contain";
  shape?: "rect" | "rounded" | "circle";
}

// ---------------------------------------------------------------------------
// Render inputs
// ---------------------------------------------------------------------------

// Per-workstation calibration (PRT-05), baked into the rendered bytes as CSS vars so
// "preview IS the print" holds. offsets in mm, scale is a unitless multiplier.
export interface Calibration {
  offsetXmm: number;
  offsetYmm: number;
  scale: number;
}

export const NO_CALIBRATION: Calibration = { offsetXmm: 0, offsetYmm: 0, scale: 1 };

// Normalized crop transform (matches personPhotoCrops / PersonView.croppedAvatarStyle).
export interface PhotoCrop {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  rotation?: number; // the card APPLIES rotation the circular avatar defers
}

// Pre-fetched image bytes the controller passes in (keeps buildHtml pure). Each field
// may be a `data:`/`http(s)://` URL (used verbatim) or a FileStorage key (read from disk
// + base64-inlined via inlineImage). Absent → the element renders blank.
export interface RenderAssets {
  photoSrc?: string; // person photo for the `photo` element
  crop?: PhotoCrop; // crop transform for the person photo
  backgroundSrc?: string; // override for layout.background.src
  imageSrcs?: Record<string, string>; // per element id → src for `image` elements
}

// ---------------------------------------------------------------------------
// Small pure utilities
// ---------------------------------------------------------------------------

// Font whitelist KEY → CSS family. Mirrors FONT_WHITELIST[].cssFamily in the editor
// and the family names embedded by renderFonts.buildFontFaceCss (KEEP IN SYNC).
const FONT_CSS: Record<string, string> = {
  sans: "'Noto Sans', sans-serif",
  serif: "'Noto Serif', serif",
  condensed: "'Archivo Narrow', sans-serif",
  mono: "'Noto Sans Mono', monospace",
};
const fontCss = (key: string): string => FONT_CSS[key] ?? FONT_CSS.sans;

// Escape text content for safe HTML embedding (React auto-escapes in the editor; the
// server must do it explicitly). Preserves \n (rendered by white-space:pre-wrap).
const esc = (s: string): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// Escape a value destined for a double-quoted HTML attribute.
const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");

const mimeFor = (key: string): string => {
  const lower = key.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
};

// Resolve an image reference to an inlinable src. Pass-through for `data:`/`http(s)://`.
// Otherwise treat it as a FileStorage key: strip any `?dt=` cache-buster and read the
// bytes from disk (`path.resolve("./content") + key` — the FileStorageHelper disk root,
// which has NO read API — RESEARCH Pitfall 2), returning a `data:<mime>;base64` URL.
// Returns "" when the ref is empty or the file is unreadable (missing-image is
// warn-but-allow → the element simply renders blank rather than throwing).
export const inlineImage = (ref?: string): string => {
  if (!ref) return "";
  if (ref.startsWith("data:") || ref.indexOf("://") > -1) return ref;
  const key = ref.split("?")[0]; // drop ?dt= cache-buster
  try {
    const bytes = fs.readFileSync(path.resolve("./content") + key);
    return `data:${mimeFor(key)};base64,${bytes.toString("base64")}`;
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------------------
// Shared page/card scaffolding (reused by buildHtml AND buildTestCardHtml)
// ---------------------------------------------------------------------------

// Base <style> shared by every rendered surface: exact-CR80 @page (the MediaBox the
// PDF will inherit), zeroed body, the embedded @font-face faces, and the absolute .el
// box. `preferCSSPageSize:true` (06-03) makes Chromium honor this @page verbatim.
const baseStyle = (): string =>
  [
    "@page { size: 85.6mm 53.98mm; margin: 0; }",
    "html, body { margin: 0; padding: 0; }",
    "* { box-sizing: border-box; }",
    ".el { position: absolute; box-sizing: border-box; overflow: hidden; white-space: pre-wrap; }",
    buildFontFaceCss(),
  ].join("\n");

// Inline style attribute for the `.card` bleed box: sized to the FULL bleed box, then
// shifted `-bleedMm,-bleedMm` so the TRIM box maps onto the exact-trim page, then the
// per-workstation calibration (offset + scale) baked in as CSS vars (PRT-05 render side).
const cardStyleAttr = (widthMm: number, heightMm: number, bleedMm: number, cal: Calibration): string =>
  [
    "position:relative",
    `width:${widthMm}mm`,
    `height:${heightMm}mm`,
    `--calX:${cal.offsetXmm}mm`,
    `--calY:${cal.offsetYmm}mm`,
    `--calScale:${cal.scale}`,
    `transform: translate(-${bleedMm}mm,-${bleedMm}mm) translate(var(--calX),var(--calY)) scale(var(--calScale))`,
    "transform-origin: top left",
    "overflow: hidden",
  ].join("; ");

// Wrap a style body + card body into a complete, self-contained HTML document.
const htmlDocument = (styleInner: string, cardStyleAttrStr: string, cardInner: string): string =>
  [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8" />',
    `<style>${styleInner}</style>`,
    "</head><body>",
    `<div class="card" style="${cardStyleAttrStr}">`,
    cardInner,
    "</div></body></html>",
  ].join("\n");

// ---------------------------------------------------------------------------
// Element rendering (reproduces CanvasElement.renderByType in native mm/pt)
// ---------------------------------------------------------------------------

// TextStyle → inline CSS in PRINT-NATIVE units (font-size in pt, NOT ptToPx).
const textCss = (font: TextStyle): string =>
  [
    `font-family:${fontCss(font.family)}`,
    `font-size:${font.sizePt}pt`,
    `font-weight:${font.weight}`,
    `color:${font.color}`,
    `text-align:${font.align}`,
    `line-height:${font.lineHeight ?? 1.2}`,
    "width:100%",
    "height:100%",
    "overflow:hidden",
    "white-space:pre-wrap",
  ].join(";");

const positionCss = (el: ElementBase): string =>
  `left:${el.xMm}mm;top:${el.yMm}mm;width:${el.wMm}mm;height:${el.hMm}mm;z-index:${el.z}`;

const shapeRadius = (shape?: "rect" | "rounded" | "circle"): string =>
  shape === "circle" ? "50%" : shape === "rounded" ? "8px" : "0";

// The crop-transformed person photo (RESEARCH Pattern 6). Reproduces
// PersonView.croppedAvatarStyle background-size/position math, PLUS rotation (which the
// circular avatar defers and the card applies) and the element's shape as border-radius.
const renderPhoto = (el: PhotoPlaceholderElement, assets: RenderAssets): string => {
  const radius = shapeRadius(el.shape);
  const src = inlineImage(assets.photoSrc);
  const crop = assets.crop;
  if (!src) {
    // Missing photo → blank region honoring the shape (warn-but-allow; the proof dialog surfaces it).
    return `<div class="el" style="${positionCss(el)};border-radius:${radius};overflow:hidden"></div>`;
  }
  if (!crop) {
    // Photo present, no crop → fill the region with object-fit, matching the editor's src preview.
    return (
      `<div class="el" style="${positionCss(el)};border-radius:${radius};overflow:hidden">` +
      `<img src="${escAttr(src)}" alt="" style="width:100%;height:100%;object-fit:${el.fit};display:block" />` +
      "</div>"
    );
  }
  const cw = crop.cropWidth || 1;
  const ch = crop.cropHeight || 1;
  const posX = cw >= 1 ? 0 : (crop.cropX / (1 - cw)) * 100;
  const posY = ch >= 1 ? 0 : (crop.cropY / (1 - ch)) * 100;
  const rot = crop.rotation ?? 0;
  const inner = [
    "width:100%",
    "height:100%",
    `background-image:url(${src})`,
    "background-repeat:no-repeat",
    `background-size:${(1 / cw) * 100}% ${(1 / ch) * 100}%`,
    `background-position:${posX}% ${posY}%`,
    `transform:rotate(${rot}deg)`,
    `border-radius:${radius}`,
    "overflow:hidden",
  ].join(";");
  return (
    `<div class="el" style="${positionCss(el)};border-radius:${radius};overflow:hidden">` +
    `<div style="${inner}"></div></div>`
  );
};

const renderElement = (el: LayoutElement, data: Record<string, string>, assets: RenderAssets): string => {
  switch (el.type) {
    case "boundText": {
      // Print fallback is "" (NOT the editor's [binding] placeholder) so an unbound field
      // prints empty rather than a debug token.
      const resolved = resolveBinding(el.binding, data, el.dateFormat) || el.fallback || "";
      const text = `${el.prefix ?? ""}${resolved}${el.suffix ?? ""}`;
      return `<div class="el" style="${positionCss(el)}"><div style="${textCss(el.font)}">${esc(text)}</div></div>`;
    }
    case "staticText":
      return `<div class="el" style="${positionCss(el)}"><div style="${textCss(el.font)}">${esc(el.text)}</div></div>`;
    case "image": {
      const src = inlineImage(assets.imageSrcs?.[el.id] ?? el.src);
      if (!src) return `<div class="el" style="${positionCss(el)}"></div>`;
      return (
        `<div class="el" style="${positionCss(el)}">` +
        `<img src="${escAttr(src)}" alt="" style="width:100%;height:100%;object-fit:${el.fit};display:block" />` +
        "</div>"
      );
    }
    case "photo":
      return renderPhoto(el, assets);
  }
};

// Absolutely-positioned background img spanning the whole bleed box (0,0 → w×h), behind
// every element. Inlined bytes; renders nothing when absent.
const renderBackground = (layout: LicenseTemplateLayout, assets: RenderAssets): string => {
  const ref = assets.backgroundSrc ?? layout.background?.src;
  const src = inlineImage(ref);
  if (!src) return "";
  const fit = layout.background?.fit ?? "cover";
  const style = [
    "position:absolute",
    "left:0",
    "top:0",
    `width:${layout.canvas.widthMm}mm`,
    `height:${layout.canvas.heightMm}mm`,
    `object-fit:${fit}`,
    "z-index:0",
    "display:block",
  ].join(";");
  return `<img src="${escAttr(src)}" alt="" style="${style}" />`;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Build a self-contained CR80 HTML string from a layout + resolved binding map +
// calibration (+ optional pre-fetched image assets). PURE: same inputs → same bytes.
export const buildHtml = (
  layout: LicenseTemplateLayout,
  data: Record<string, string>,
  calibration: Calibration = NO_CALIBRATION,
  assets: RenderAssets = {}
): string => {
  const { widthMm, heightMm, bleedMm } = layout.canvas;
  const bg = renderBackground(layout, assets);
  const els = [...layout.elements]
    .sort((a, b) => a.z - b.z)
    .map((el) => renderElement(el, data, assets))
    .join("\n");
  const cardInner = `${bg}\n${els}`;
  return htmlDocument(baseStyle(), cardStyleAttr(widthMm, heightMm, bleedMm, calibration), cardInner);
};

// CR80 trim geometry — the test card is built at TRIM (bleed 0) so its marks land on the
// exact page edges the operator physically calibrates against.
const TRIM_W = 85.6;
const TRIM_H = 53.98;

// A single absolutely-positioned black hairline div (mm coordinates).
const bar = (leftMm: number, topMm: number, wMm: number, hMm: number): string =>
  `<div style="position:absolute;left:${leftMm}mm;top:${topMm}mm;width:${wMm}mm;height:${hMm}mm;background:#000"></div>`;

// L-shaped corner registration marks: two arms meeting at each of the 4 corners.
const cornerMarks = (): string => {
  const arm = 5; // mm
  const thk = 0.3; // mm
  const marks: string[] = [];
  // top-left
  marks.push(bar(0, 0, arm, thk), bar(0, 0, thk, arm));
  // top-right
  marks.push(bar(TRIM_W - arm, 0, arm, thk), bar(TRIM_W - thk, 0, thk, arm));
  // bottom-left
  marks.push(bar(0, TRIM_H - thk, arm, thk), bar(0, TRIM_H - arm, thk, arm));
  // bottom-right
  marks.push(bar(TRIM_W - arm, TRIM_H - thk, arm, thk), bar(TRIM_W - thk, TRIM_H - arm, thk, arm));
  return marks.join("");
};

// Center crosshair: full-height + full-width hairlines through 50%/50%.
const centerCrosshair = (): string => {
  const thk = 0.2; // mm
  return (
    bar(TRIM_W / 2 - thk / 2, 0, thk, TRIM_H) + // vertical
    bar(0, TRIM_H / 2 - thk / 2, TRIM_W, thk) // horizontal
  );
};

// A small mm label near a tick (mono font so digits are legible at print size).
const tickLabel = (leftMm: number, topMm: number, value: number): string =>
  `<div style="position:absolute;left:${leftMm}mm;top:${topMm}mm;font-family:${FONT_CSS.mono};font-size:4pt;color:#000;line-height:1">${value}</div>`;

// mm ruler ticks along all four edges: a tick every 1mm, longer every 5mm, labelled
// every 10mm — drawn in the card's native mm space so the operator reads the physical
// offset directly off the printed card.
const rulerTicks = (): string => {
  const thk = 0.15; // mm hairline
  const minorLen = 1.2;
  const majorLen = 2.4; // every 5mm
  const labelLen = 3.2; // every 10mm
  const parts: string[] = [];
  // top + bottom edges: vertical ticks at each x mm
  for (let x = 0; x <= Math.floor(TRIM_W); x++) {
    const len = x % 10 === 0 ? labelLen : x % 5 === 0 ? majorLen : minorLen;
    parts.push(bar(x, 0, thk, len)); // top edge
    parts.push(bar(x, TRIM_H - len, thk, len)); // bottom edge
    if (x % 10 === 0 && x > 0 && x < TRIM_W) parts.push(tickLabel(x + 0.3, len + 0.2, x));
  }
  // left + right edges: horizontal ticks at each y mm
  for (let y = 0; y <= Math.floor(TRIM_H); y++) {
    const len = y % 10 === 0 ? labelLen : y % 5 === 0 ? majorLen : minorLen;
    parts.push(bar(0, y, len, thk)); // left edge
    parts.push(bar(TRIM_W - len, y, len, thk)); // right edge
    if (y % 10 === 0 && y > 0 && y < TRIM_H) parts.push(tickLabel(len + 0.2, y + 0.3, y));
  }
  return parts.join("");
};

// Build the per-workstation calibration test card (PRT-05). Same @page, same .card
// calibration transform, and same page pipeline as buildHtml — so the operator
// calibrates against the EXACT geometry real cards use. Content: corner registration
// marks + center crosshair + mm ruler ticks. No licenseTemplate row is involved.
export const buildTestCardHtml = (calibration: Calibration = NO_CALIBRATION): string => {
  const cardInner = [cornerMarks(), centerCrosshair(), rulerTicks()].join("\n");
  // bleed 0 → the card IS the trim page; the calibration transform is otherwise identical.
  return htmlDocument(baseStyle(), cardStyleAttr(TRIM_W, TRIM_H, 0, calibration), cardInner);
};

// ---------------------------------------------------------------------------
// Puppeteer boundary — shared Chromium + exact-CR80 page.pdf
// ---------------------------------------------------------------------------

// Module-singleton browser. Launching Chromium per render is the #1 render-pipeline
// pitfall (RESEARCH Pitfall 1: seconds of cold-launch latency + fd/zombie leaks under
// concurrency). We launch ONCE, keep the Browser, and only open/close a fresh PAGE per
// render. `_launching` de-dupes concurrent first-render launches into one browser.
let _browser: Browser | null = null;
let _launching: Promise<Browser> | null = null;

// Puppeteer is ESM-only. In production (NodeNext ESM) a plain `import("puppeteer")` is fine,
// but ts-jest's CommonJS transform downlevels a literal `import()` to `require()`, which
// chokes on puppeteer's ESM `export` syntax — so the PRT-06 test would silently skip forever.
// Routing through an indirect dynamic import the transpiler can't rewrite keeps it a NATIVE
// import() in BOTH runtimes (native import() loads ESM even from a CommonJS caller), so the
// dimension guard actually executes Chromium under Jest/CI.
const importDynamic = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<any>;

// Resolve the system Chromium exactly like PuppeteerHealthController (the Phase-0-proven
// Railway launch): prefer PUPPETEER_EXECUTABLE_PATH, else `which chromium…`. Empty string
// → let Puppeteer fall back to its bundled binary (used by local dev / CI when set).
const resolveExecutablePath = (): string => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    return execSync("which chromium || which chromium-browser || which google-chrome-stable || which google-chrome")
      .toString()
      .trim();
  } catch {
    return "";
  }
};

// Get the shared Chromium, launching (once) or re-launching if it has disconnected/crashed.
// Reproduces PuppeteerHealthController's launch args (--no-sandbox is REQUIRED in the
// Railway/CI container; --disable-dev-shm-usage avoids /dev/shm exhaustion).
export const getSharedBrowser = async (): Promise<Browser> => {
  if (_browser?.connected) return _browser;
  if (_launching) return _launching;
  _launching = (async () => {
    const puppeteer = (await importDynamic("puppeteer")).default;
    const executablePath = resolveExecutablePath();
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    _browser = browser;
    _launching = null;
    return browser;
  })();
  try {
    return await _launching;
  } catch (err) {
    _launching = null;
    throw err;
  }
};

// Close the shared browser (test teardown / graceful shutdown). Safe to call when unset.
export const closeSharedBrowser = async (): Promise<void> => {
  const b = _browser;
  _browser = null;
  _launching = null;
  if (b) {
    try {
      await b.close();
    } catch {
      /* already gone */
    }
  }
};

// Render a buildHtml/buildTestCardHtml string to an EXACT-CR80 PDF via the shared Chromium.
// The page.pdf options are load-bearing and MUST NOT change:
//   preferCSSPageSize:true — honor the @page 85.6mm×53.98mm VERBATIM. Default (false) makes
//     Chromium scale the card onto Letter — the exact silent "scale-to-fit" PRT-06 guards.
//   printBackground:true   — default false drops background photos/colors (blank cards).
//   scale:1                — calibration scale lives in CSS (06-02 cardStyleAttr), NEVER here.
//   margin all 0 + pageRanges:"1" — one exact-trim page, no printer margins.
// Opens a fresh page per render and closes the PAGE (keeps the shared BROWSER alive).
export const renderPdf = async (html: string): Promise<Buffer> => {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    // Wait for embedded @font-face faces to finish loading so text metrics are final
    // before the PDF is snapshotted (otherwise the first render can capture fallback fonts).
    await page.evaluateHandle("document.fonts.ready");
    const pdf = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      scale: 1,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      pageRanges: "1",
      tagged: false,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
};

export const LicenseRenderHelper = {
  buildHtml,
  buildTestCardHtml,
  inlineImage,
  getSharedBrowser,
  closeSharedBrowser,
  renderPdf,
  NO_CALIBRATION,
};
