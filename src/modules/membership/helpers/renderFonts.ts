// renderFonts.ts — self-hosted @font-face CSS for the license-card renderer.
//
// PHASE 6 FONT CONTRACT (see forks/B1Admin/src/licenseTemplates/helpers/fonts.ts):
// the layout JSON stores a stable KEY (sans/serif/condensed/mono) that maps to a
// `cssFamily` string. The editor loads these 4 families (weights 400/700) via
// webfontloader/Google for preview parity; the SERVER renderer must embed the SAME
// families so headless-Chromium produces identical text metrics (RESEARCH Pitfall 3 —
// Archivo Narrow is NOT in nixpkgs, so bundling the woff2 is MANDATORY, not optional).
//
// The `font-family` names emitted below MUST byte-match the family names inside the
// editor's `cssFamily` strings ('Noto Sans', 'Noto Serif', 'Archivo Narrow',
// 'Noto Sans Mono') so a rule `font-family: 'Noto Sans', sans-serif` resolves to the
// embedded face. The woff2 binaries live in ../assets/fonts (committed into the Api
// repo) and are read + base64-inlined as data URLs — no network, no substitution.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Resolve the bundled-font directory relative to THIS module so it works both when
// running from source (tsx/ts-jest → src/.../helpers) and compiled (dist/.../helpers,
// with the woff2 copied alongside via the build's copy-assets step).
const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");

interface FontFace {
  family: string; // CSS family name (must match the whitelist cssFamily primary name)
  weight: 400 | 700;
  file: string; // woff2 filename under FONTS_DIR
}

// The 4 whitelisted families × 2 weights = 8 faces. Family names mirror
// FONT_WHITELIST[].cssFamily in the B1Admin editor (KEEP IN SYNC).
export const FONT_FACES: FontFace[] = [
  { family: "Noto Sans", weight: 400, file: "noto-sans-400.woff2" },
  { family: "Noto Sans", weight: 700, file: "noto-sans-700.woff2" },
  { family: "Noto Serif", weight: 400, file: "noto-serif-400.woff2" },
  { family: "Noto Serif", weight: 700, file: "noto-serif-700.woff2" },
  { family: "Archivo Narrow", weight: 400, file: "archivo-narrow-400.woff2" },
  { family: "Archivo Narrow", weight: 700, file: "archivo-narrow-700.woff2" },
  { family: "Noto Sans Mono", weight: 400, file: "noto-sans-mono-400.woff2" },
  { family: "Noto Sans Mono", weight: 700, file: "noto-sans-mono-700.woff2" },
];

// Cache the built CSS — the woff2 bytes never change at runtime and base64-encoding
// ~100KB of fonts on every render would be wasteful.
let cachedCss: string | null = null;

// Build the @font-face CSS block for all 8 faces, each with an inlined
// data:font/woff2;base64 source. Returned string is safe to drop inside a <style>.
export const buildFontFaceCss = (): string => {
  if (cachedCss !== null) return cachedCss;
  const blocks = FONT_FACES.map((face) => {
    const bytes = fs.readFileSync(path.join(FONTS_DIR, face.file));
    const b64 = bytes.toString("base64");
    return [
      "@font-face {",
      `  font-family: '${face.family}';`,
      "  font-style: normal;",
      `  font-weight: ${face.weight};`,
      "  font-display: block;",
      `  src: url(data:font/woff2;base64,${b64}) format('woff2');`,
      "}",
    ].join("\n");
  });
  cachedCss = blocks.join("\n");
  return cachedCss;
};
