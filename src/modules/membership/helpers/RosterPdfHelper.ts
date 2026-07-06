// RosterPdfHelper.ts — the A4-landscape leadership-roster PDF builder (RPT-04/05).
//
// Two responsibilities, cleanly split from the PURE grouping in reportGrouping.ts:
//   1. buildRosterHtml — turn the grouped model into a paginating A4-landscape HTML table.
//   2. render — drive the SHARED headless Chromium (getSharedBrowser, reused from the Phase-6
//      renderer — NEVER a second browser) and let Chromium paginate the long table natively.
//
// It does NOT re-implement grouping: filterRows + buildGroupedModel come from reportGrouping.ts,
// guaranteeing the PDF grouping is the SAME code path the parity harness checks (RPT-05).
//
// PAGINATION (RESEARCH Pitfall 5): this is a MULTI-page document, the opposite of the CR80
// single-card renderer. So it does NOT pin a single page window in page.pdf — omitting that lets
// Chromium flow the table across as many pages as the roster needs. `thead { display:
// table-header-group }` repeats the column headers on every page; `break-inside: avoid` keeps a
// row (and a group header) from splitting across a page break. Do NOT reuse
// LicenseRenderHelper.buildHtml/renderPdf — those are CR80-locked (@page 85.6mm×53.98mm).

import { buildFontFaceCss } from "./renderFonts.js";
import { getSharedBrowser } from "./LicenseRenderHelper.js";
import {
  filterRows,
  buildGroupedModel,
  type ReportRow,
  type ReportFilterSpec,
  type NameLabel,
  type TypeLabel,
  type CampusLabel,
  type GroupedModel,
  type GroupNode
} from "./reportGrouping.js";

// HTML-escape interpolated text (the server has no React auto-escaping).
const esc = (s: string): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// The 7 report columns (RPT-04).
const COLUMNS = ["Name", "Campus", "Ordination(s)", "Status", "Credential #", "Granted", "Expires"];

const COL_COUNT = COLUMNS.length;

const dataRowHtml = (row: {
  name: string;
  campusName: string;
  typeName: string;
  status: string;
  credentialNumber: string;
  grantedDate: string;
  expirationDate: string;
}): string =>
  "<tr class=\"data-row\">" +
  `<td>${esc(row.name)}</td>` +
  `<td>${esc(row.campusName)}</td>` +
  `<td>${esc(row.typeName)}</td>` +
  `<td>${esc(row.status)}</td>` +
  `<td>${esc(row.credentialNumber)}</td>` +
  `<td>${esc(row.grantedDate)}</td>` +
  `<td>${esc(row.expirationDate)}</td>` +
  "</tr>";

// A group-header row spanning all columns, carrying the label + distinct-person count. `level`
// controls the indent/emphasis for the nested (secondary) grouping.
const groupHeaderHtml = (label: string, personCount: number, level: number): string =>
  `<tr class="group-header level-${level}"><td colspan="${COL_COUNT}">` +
  `<span class="grp-label">${esc(label)}</span>` +
  `<span class="grp-count">${personCount} ${personCount === 1 ? "person" : "people"}</span>` +
  "</td></tr>";

const nodeRowsHtml = (node: GroupNode, level: number): string => {
  const parts: string[] = [groupHeaderHtml(node.label, node.personCount, level)];
  if (node.subGroups.length) {
    for (const sub of node.subGroups) parts.push(nodeRowsHtml(sub, level + 1));
  } else {
    for (const row of node.rows) parts.push(dataRowHtml(row));
  }
  return parts.join("\n");
};

const STYLE = [
  "@page { size: A4 landscape; margin: 12mm; }",
  "html, body { margin: 0; padding: 0; }",
  "* { box-sizing: border-box; }",
  "body { font-family: 'Noto Sans', sans-serif; color: #111; font-size: 9pt; }",
  "h1 { font-size: 14pt; margin: 0 0 6pt 0; }",
  ".meta { font-size: 8pt; color: #555; margin: 0 0 10pt 0; }",
  "table { width: 100%; border-collapse: collapse; }",
  // Repeat the column headers on EVERY page (Pitfall 5).
  "thead { display: table-header-group; }",
  "th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.3pt; " +
    "border-bottom: 1.2pt solid #333; padding: 4pt 6pt; background: #f0f0f0; }",
  "td { padding: 3pt 6pt; border-bottom: 0.5pt solid #ddd; vertical-align: top; }",
  // Keep a row / group header intact across page breaks (Pitfall 5).
  "tr, .group-header { break-inside: avoid; }",
  ".group-header td { background: #e9eef5; border-bottom: 1pt solid #b9c6d8; padding: 5pt 6pt; }",
  ".group-header.level-1 td { background: #f4f7fb; padding-left: 14pt; }",
  ".grp-label { font-weight: 700; }",
  ".grp-count { float: right; color: #555; font-weight: 400; }",
  ".empty { color: #777; font-style: italic; padding: 12pt 0; }",
  buildFontFaceCss()
].join("\n");

export const buildRosterHtml = (model: GroupedModel, spec: ReportFilterSpec): string => {
  const head =
    "<thead><tr>" + COLUMNS.map((c) => `<th>${esc(c)}</th>`).join("") + "</tr></thead>";

  const hasRows = model.groups.some((g) => g.rows.length || g.subGroups.length);
  const body = hasRows
    ? model.groups.map((g) => nodeRowsHtml(g, 0)).join("\n")
    : `<tr><td colspan="${COL_COUNT}" class="empty">No ministers match these filters.</td></tr>`;

  const groupDesc = [spec.groupBy1, spec.groupBy2].filter((g) => g !== "none").join(" › ") || "none";
  const meta =
    `Grouped by: ${esc(groupDesc)} · Sorted by: ${esc(spec.sortBy)} (${esc(spec.sortDir)}) · ` +
    `${model.totalPeople} ${model.totalPeople === 1 ? "person" : "people"}`;

  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8" />',
    `<style>${STYLE}</style>`,
    "</head><body>",
    "<h1>Leadership Roster</h1>",
    `<div class="meta">${meta}</div>`,
    "<table>",
    head,
    "<tbody>",
    body,
    "</tbody>",
    "</table>",
    "</body></html>"
  ].join("\n");
};

// Render the grouped roster to a paginated A4-landscape PDF via the SHARED Chromium.
// Re-applies filter+group from the pure module (idempotent — the controller may pass already
// filtered rows), so the rendered contents provably match what the endpoint advertised.
export const render = async (
  rows: ReportRow[],
  names: Record<string, NameLabel>,
  types: Record<string, TypeLabel>,
  campuses: Record<string, CampusLabel>,
  spec: ReportFilterSpec
): Promise<Buffer> => {
  // filterRows here is idempotent with buildGroupedModel's own internal filter — kept explicit
  // to document that render sees the SAME filtered set the header was derived from.
  const filtered = filterRows(rows, spec);
  const model = buildGroupedModel(filtered, names, types, campuses, spec);
  const html = buildRosterHtml(model, spec);

  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluateHandle("document.fonts.ready");
    const pdf = await page.pdf({
      preferCSSPageSize: true, // honor @page A4 landscape verbatim
      printBackground: true,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" }
      // NB: deliberately no single-page window here — the roster must flow across pages.
    });
    return Buffer.from(pdf);
  } finally {
    await page.close(); // close the PAGE, keep the shared BROWSER alive
  }
};

export const RosterPdfHelper = {
  buildRosterHtml,
  render
};
