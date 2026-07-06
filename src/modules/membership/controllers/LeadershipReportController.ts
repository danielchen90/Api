import { controller, httpPost } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { CampusScopeHelper } from "../helpers/index.js";
import { RosterPdfHelper } from "../helpers/RosterPdfHelper.js";
import {
  buildReportRows,
  filterRows,
  normalizeSpec,
  type NameLabel,
  type TypeLabel,
  type CampusLabel
} from "../helpers/reportGrouping.js";

/**
 * Leadership-reports API — the ONE server-side piece of Phase 8 (RPT-05 / RPT-06).
 *
 * POST /membership/reports/leadership/pdf renders a print-friendly, GROUPED A4-landscape
 * leadership-roster PDF and streams it back. Headless Chromium only runs on the API, so the PDF
 * MUST be produced here (the on-screen roster is built client-side from the SAME shared grouping
 * contract — see reportGrouping.ts / Plan 08-02).
 *
 * GATING (deliberately different from the CR80 render controllers): this is READ-ONLY, so it
 * gates on People-VIEW, NOT a write permission. Read-only Reporter / Campus-Viewer roles are the
 * intended audience; a write gate would 401 them (Pitfall 1). The permission is UNPREFIXED (no
 * apiName) — a prefixed permission 401s every campus request (campus-auth memory).
 *
 * SCOPE (RPT-06): the caller's CampusScope is re-resolved SERVER-SIDE (CampusScopeHelper.resolve)
 * and the roster is loaded through the scoped repo. Client-supplied campusIds are only ever a
 * DISPLAY filter WITHIN that scope — they can never widen it (applyCampusScope structurally
 * prevents leakage, Pitfall 2). The endpoint echoes the campusIds ACTUALLY present in the
 * scoped-then-filtered roster via X-Report-Campus-Ids, so RPT-06 can be asserted automatically
 * against the endpoint's own output (never from spec.campusIds).
 */
// NOTE: the class name MUST be globally unique across ALL modules — inversify-express-utils
// registers controllers by class name and throws "Two controllers cannot have the same name"
// at startup on a collision. The reporting module already ships a `ReportController`, so this
// membership one is `LeadershipReportController` (08-03 fix — the 08-01 name collided and
// crash-looped the server on deploy: healthcheck failed / 502).
@controller("/membership/reports")
export class LeadershipReportController extends MembershipBaseController {

  @httpPost("/leadership/pdf")
  public async leadershipPdf(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // 1. READ-CAPABILITY GATE — People-View, UNPREFIXED (omit apiName). NOT a write gate, so a
      //    read-only Reporter / Campus-Viewer can drive the report.
      if (!au.checkAccess({ contentType: "People", action: "View" })) return this.json({}, 401);

      // 2. SCOPE re-resolved SERVER-SIDE — never read scope from the body (Pitfall 3).
      const scope = await CampusScopeHelper.resolve(au, this.repos);

      // 3. LOAD SCOPED — client campusIds cannot widen past this scoped set (RPT-06).
      const ordinations = await this.repos.personOrdination.loadAll(au.churchId, scope);

      // 4. Parse the ReportFilterSpec with defensive defaults for every missing field.
      const spec = normalizeSpec(req.body);

      // 5. JOIN names / types / campuses for the distinct people in the scoped set (GUARD empty).
      const personIds = [...new Set(ordinations.map((o) => o.personId).filter(Boolean) as string[])];
      const people = personIds.length ? await this.repos.person.loadByIds(au.churchId, personIds) : [];
      const namesById: Record<string, NameLabel> = {};
      for (const p of people as any[]) {
        namesById[p.id] = {
          firstName: p.firstName || "",
          lastName: p.lastName || "",
          displayName: p.displayName || ""
        };
      }
      const typesById: Record<string, TypeLabel> = {};
      for (const t of await this.repos.ordinationType.loadAll(au.churchId)) {
        typesById[t.id] = { name: t.name || "", sortOrder: t.sortOrder ?? 999 };
      }
      const campusesById: Record<string, CampusLabel> = {};
      for (const c of await this.repos.campus.loadAll(au.churchId)) {
        campusesById[c.id] = { name: c.name || "" };
      }

      // 6. Build the atomic report rows, compute the FINAL displayed set and the ACTUAL campus
      //    set (RPT-06 automated proof on the endpoint's OWN output). Derived from the scoped
      //    rows through the SAME filterRows the PDF renders — NEVER from spec.campusIds, so an
      //    out-of-scope campusIds request can never surface an out-of-scope id in the header.
      const rows = buildReportRows(ordinations as any[], namesById);
      const finalRows = filterRows(rows, spec);
      const actualCampusIds = [...new Set(finalRows.map((r) => r.campusId).filter(Boolean))];
      res.setHeader("X-Report-Campus-Ids", actualCampusIds.join(","));
      res.setHeader("Access-Control-Expose-Headers", "X-Report-Campus-Ids");

      // 7. Render the grouped roster PDF (render re-applies filter+group from the shared module,
      //    so the header set provably matches the PDF contents).
      const pdf = await RosterPdfHelper.render(rows, namesById, typesById, campusesById, spec);

      // 8. Stream application/pdf (mirror the LicenseCardController byte-streaming tail).
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="leadership-report.pdf"');
      return res.send(pdf);
    });
  }
}
