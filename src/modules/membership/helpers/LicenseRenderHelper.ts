// LicenseRenderHelper.ts — the PURE HTML-generation core of the license-card renderer.
//
// Reproduces the Phase 5 editor's CanvasElement.renderByType + Canvas.tsx card wrapper
// (forks/B1Admin/src/licenseTemplates/editor/*) in NATIVE CSS mm/pt — NO PX_PER_MM, NO
// ptToPx. Headless Chromium (added in 06-03) turns this HTML into an EXACT-CR80 PDF via
// `@page { size: 85.6mm 53.98mm; margin: 0 }` + `preferCSSPageSize:true`, so the printed
// card is byte-faithful to the editor preview (RESEARCH §Architecture Pattern 1).
//
// This module is Puppeteer-FREE: buildHtml/buildTestCardHtml are pure string builders.
// The 06-04 controller does the DB/FileStorage fetching and passes bytes in via `assets`.

import fs from "fs";
import path from "path";
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

export const LicenseRenderHelper = {
  buildHtml,
  inlineImage,
  NO_CALIBRATION,
};
