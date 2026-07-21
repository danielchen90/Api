import { controller, httpGet, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { toPublicCampus, toPublicCampusEvent, type PublicCampusDTO, type PublicCampusEventDTO } from "../helpers/PublicDto.js";

/**
 * PublicCampusController — anonymous public reads that feed the public website's map,
 * Locations nav, campus routing, and per-campus events (SITE-02/03, MAP-01..04, EVT-01).
 *
 * ANONYMOUS: every method is wrapped in `actionWrapperAnon` (no `au`, no auth, no
 * permission gate) — the SAME pattern as PublicLeadershipController. Safety comes from
 * projecting every row through a `toPublic*` whitelist builder (PublicDto), never from a
 * caller identity, and never by returning a raw row.
 *
 * ROUTE SAFETY (messaging-route-collision memory): mounted under the distinct multi-
 * segment `/membership/public` prefix; every route here is multi-segment, so it can
 * never be swallowed by a single-segment `/:id` catch-all.
 */
@controller("/membership/public")
export class PublicCampusController extends MembershipBaseController {
  /**
   * GET /membership/public/:churchId/campuses
   *
   * The anonymous campus LIST that feeds the SSR map props, the Locations nav dropdown,
   * and the crawlable list (MAP-01..04, SITE-02 routing). Every row is projected through
   * `toPublicCampus` — slug + lat/lng + public address only, no churchId/importKey/PII.
   */
  @httpGet("/:churchId/campuses")
  public async campuses(@requestParam("churchId") churchId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      if (!churchId) return [];
      const rows = (await this.repos.campus.loadPublicList(churchId)) as any[];
      const result: PublicCampusDTO[] = (rows || []).map(toPublicCampus);
      return result;
    });
  }

  /**
   * GET /membership/public/:churchId/:campusId/events
   *
   * Anonymous, display-only FUTURE events for a campus (EVT-01), joined via
   * `group.campusId`, sorted ascending, projected through `toPublicCampusEvent`. Empty →
   * `[]` (the UI hides the section silently).
   *
   * ── SCOPE NOTE (module ownership, RESOLVED conservatively) ──────────────────────────
   * The plan (Task 3 MODULE OWNERSHIP) requires this events read to stay MEMBERSHIP-owned
   * and forbids expanding into the content module. At execution time the `events` table
   * does NOT exist in the membership database: `events` is defined only in the CONTENT
   * module (forks/Api/src/modules/content — Event model + EventRepo), and membership and
   * content are SEPARATE MySQL databases (MEMBERSHIP_CONNECTION_STRING -> `/membership`,
   * CONTENT_CONNECTION_STRING -> `/content`). The membership `getDb()` connection cannot
   * reach `content.events`, and there is no registered membership→content connection.
   *
   * The plan's own instruction for exactly this case: "If the group→event data genuinely
   * cannot be reached from the membership module at execution time, STOP — treat it as a
   * scope change rather than silently expanding into the content module." So the route
   * surface + whitelist projection ship here now (membership-only, leak-gated), but the
   * actual event-store read is DEFERRED to the scope decision (see 20-01-SUMMARY.md).
   * Until then this returns `[]` (the documented empty-safe behavior) — never a leak,
   * never a cross-DB reach. When the decision lands, the resolved-group-id read plugs in
   * right here, still projected through `toPublicCampusEvent`, still leak-gated.
   */
  @httpGet("/:churchId/:campusId/events")
  public async events(@requestParam("churchId") churchId: string, @requestParam("campusId") campusId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      if (!churchId || !campusId) return [];

      // Resolve the campus's groups (membership-owned join). These group ids are what a
      // future event read filters on.
      const groups = (await this.repos.group.loadAll(churchId)) as any[];
      const campusGroupIds = (groups || []).filter((g) => g.campusId === campusId).map((g) => g.id);
      if (campusGroupIds.length === 0) return [];

      // DEFERRED (see SCOPE NOTE): the future-event read against the shared event store by
      // campusGroupIds lands here once the cross-module scope decision is made. Until then
      // return the empty-safe response so the public UI silently hides the events section.
      const now = new Date();
      const rows: any[] = []; // no membership-reachable event store; see SCOPE NOTE
      const result: PublicCampusEventDTO[] = rows
        .filter((e) => e?.start && new Date(e.start) >= now)
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
        .map(toPublicCampusEvent);
      return result;
    });
  }
}
