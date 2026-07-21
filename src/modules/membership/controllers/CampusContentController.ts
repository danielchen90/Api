import { controller, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { Permissions } from "../helpers/index.js";
import { CampusScopeHelper } from "../helpers/CampusScopeHelper.js";
import { assertWritableCampus } from "../helpers/applyCampusScope.js";
import { resolveForCampus, HIDDEN, type CampusContentFields } from "../helpers/CampusContentResolver.js";
import { pickWhitelist } from "../helpers/PublicDto.js";
import { CampusContent } from "../models/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";

/**
 * CampusContentController — the CMS-01 ENDPOINT half (Plan 05).
 *
 * TWO surfaces over the Plan-03 model layer (CampusContentRepo + CampusContentResolver):
 *
 *   1. An ANONYMOUS public read (`GET /membership/campusContent/public/:churchId[/:campusId]`)
 *      that returns the org-default overlaid with the campus override FIELD-BY-FIELD, projected
 *      through the PublicDto positive-whitelist so a stray/new column can NEVER leak (criterion 6,
 *      the data-safety gate). Mirrors PublicLeadershipController / SettingController.appTheme
 *      (`actionWrapperAnon`, no `au`).
 *
 *   2. An AUTHENTICATED, church+campus-SCOPED write (`POST /membership/campusContent`) that
 *      Phase 21's authoring UI persists org-default (campusId NULL) and per-campus overrides
 *      against. It gates on the UNPREFIXED Content/Edit permission (campus-auth-perms-unprefixed
 *      memory — a prefixed constant 401s), derives the writable campus scope SERVER-SIDE, rejects a
 *      client-widened campusId via `assertWritableCampus`, normalizes cleared/blank override fields
 *      to "no override" (inherit), and guards the update with OCC (409 on a stale version).
 *
 * SINGLE contentType: the whole public-website field-set (CampusContentFields) is one JSON blob
 * stored under the `SITE_CONTENT_TYPE` contentType — one org-default row + one row per overriding
 * campus. The repo/resolver's contentType dimension stays available for future split content types.
 *
 * ROUTE SAFETY (messaging-route-collision memory): mounted under the multi-segment
 * `/membership/campusContent` prefix; the anonymous reads are `/public/:churchId[/:campusId]`
 * (multi-segment, cannot be swallowed by a `/:id` catch-all), and the only single-segment route is
 * the authed `POST /` — declared with NO `/:id` catch-all after it.
 */
@controller("/membership/campusContent")
export class CampusContentController extends MembershipBaseController {
  // The one contentType the whole public-website field-set is stored under.
  private static SITE_CONTENT_TYPE = "site";

  // The exact whitelist of publishable content keys — the ONLY keys that can ever reach the
  // anonymous surface. A stray/new DB column can never leak because it is never named here.
  private static CONTENT_KEYS: (keyof CampusContentFields)[] = [
    "mission",
    "about",
    "welcomeNote",
    "pastorNote",
    "heroImage",
    "serviceTimes",
    "facebookUrl",
    "instagramUrl",
    "youtubeUrl",
    "givingUrl",
    "sermonYoutubeChannel",
    "extraLinks"
  ];

  // ── Anonymous public read: resolved-for-campus content as a redacting whitelist DTO ──
  // Campus variant: org default overlaid with THIS campus's override, field-by-field.
  @httpGet("/public/:churchId/:campusId")
  public async publicForCampus(
    @requestParam("churchId") churchId: string,
    @requestParam("campusId") campusId: string,
    req: express.Request,
    res: express.Response
  ): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => this.resolvePublic(churchId, campusId));
  }

  // Campus-less variant: the org default resolved (no campus override applied).
  @httpGet("/public/:churchId")
  public async publicOrgDefault(
    @requestParam("churchId") churchId: string,
    req: express.Request,
    res: express.Response
  ): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => this.resolvePublic(churchId, null));
  }

  // Shared resolve+project so both anon variants return the IDENTICAL clean DTO shape.
  private async resolvePublic(churchId: string, campusId: string | null): Promise<Partial<CampusContentFields>> {
    if (!churchId) return {};
    const contentType = CampusContentController.SITE_CONTENT_TYPE;

    const orgRow = await this.repos.campusContent.loadOrgDefault(churchId, contentType);
    const orgFields = CampusContentController.parseContent(orgRow);

    let overrideFields: CampusContentFields | null = null;
    if (campusId) {
      const campusRow = await this.repos.campusContent.loadForCampus(churchId, campusId, contentType);
      overrideFields = CampusContentController.parseContent(campusRow);
    }

    // Field-level merge (Plan 03): override where present, org default otherwise.
    const resolved = resolveForCampus(orgFields, overrideFields);

    // Project through the positive whitelist — NEVER the raw repo row (no id/version/churchId/
    // campusId/timestamps). A stray column can never leak (criterion 6, the data-safety gate).
    return pickWhitelist<CampusContentFields>(resolved, CampusContentController.CONTENT_KEYS);
  }

  // Parse a repo row's JSON `content` string into the typed field-set. Missing row / bad JSON →
  // null (an absent side the resolver treats as "no fields").
  private static parseContent(row: CampusContent | null): CampusContentFields | null {
    if (!row || !row.content) return null;
    try {
      return typeof row.content === "string" ? (JSON.parse(row.content) as CampusContentFields) : (row.content as any);
    } catch {
      return null;
    }
  }
}
