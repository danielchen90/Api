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

  // ── Authenticated, church+campus-SCOPED write (Phase 21 authors against this) ──
  // Body: { campusId?: string | null, content: CampusContentFields, version?: number }.
  //   - campusId NULL/absent   = the ORG DEFAULT write (requires org-wide edit scope).
  //   - campusId set           = that campus's SPARSE override (must be within the caller's scope).
  // Empty override fields are normalized to "no override" (inherit org default); an explicit
  // HIDDEN sentinel is PRESERVED (distinct from empty — a campus deliberately blanking a field).
  @httpPost("/")
  public async save(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // UNPREFIXED Content/Edit gate (campus-auth-perms-unprefixed: a prefixed constant 401s).
      if (!au.checkAccess(Permissions.content.edit)) return this.json({}, 401);

      const body: any = req.body ?? {};
      // NULL campusId = org-default write. Never trust it without the scope guard below.
      const campusId: string | null = body.campusId ?? null;

      // Derive the writable campus scope SERVER-SIDE (never from the body). assertWritableCampus:
      //   org-default (NULL campusId) → permitted ONLY for an org-wide ("all") scope;
      //   a real campusId             → permitted only when it is within the caller's scope
      //                                  (a scoped user cannot widen to a campus they don't own).
      const scope = await CampusScopeHelper.resolve(au, this.repos);
      const scopeTarget = campusId ?? CampusContentController.ORG_WIDE_TARGET;
      if (!assertWritableCampus(scope, scopeTarget)) return this.json({}, 401);

      const contentType = CampusContentController.SITE_CONTENT_TYPE;

      // Normalize the incoming fields: strip EMPTY override fields so a cleared/blank campus edit
      // re-inherits the org default rather than persisting an empty value. HIDDEN is preserved.
      const fields = CampusContentController.normalizeOverride(body.content, campusId);

      // Locate an existing row for this (church, campusId, contentType) to decide create-vs-update.
      const existing =
        campusId === null
          ? await this.repos.campusContent.loadOrgDefault(au.churchId, contentType)
          : await this.repos.campusContent.loadForCampus(au.churchId, campusId, contentType);

      const model = new CampusContent();
      model.churchId = au.churchId;
      model.campusId = campusId;
      model.contentType = contentType;
      model.content = JSON.stringify(fields);

      if (!existing || !existing.id) {
        // CREATE — pre-assign a stable id and route explicitly as new (NOT id-presence, per the
        // repo's isNew contract). The repo respects a caller-supplied id.
        model.id = UniqueIdHelper.shortId();
        const created = await this.repos.campusContent.save(model, true);
        return this.repos.campusContent.convertToModel(au.churchId, created);
      }

      // UPDATE with OCC — guard on the version the client last read (body.version) when supplied,
      // else the stored version. A stale guard (numUpdatedRows === 0n) → 409.
      model.id = existing.id;
      const expectedVersion = typeof body.version === "number" ? body.version : existing.version ?? 1;
      const numUpdated = await this.repos.campusContent.updateWithVersion(model, expectedVersion);
      if (numUpdated === 0n) return this.json({ error: "stale version" }, 409);

      // Re-read so the caller gets the fresh, bumped version.
      const fresh =
        campusId === null
          ? await this.repos.campusContent.loadOrgDefault(au.churchId, contentType)
          : await this.repos.campusContent.loadForCampus(au.churchId, campusId, contentType);
      return this.repos.campusContent.convertToModel(au.churchId, fresh);
    });
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

  // The org-wide write target passed to assertWritableCampus for a NULL-campusId (org-default)
  // write — a non-empty sentinel so an "all"-scope caller is permitted (assertWritableCampus's
  // "all" branch rejects only empty/falsy targets) while a "scoped"/"deny" caller is rejected
  // (the sentinel is never a real campusId in anyone's assigned set).
  private static ORG_WIDE_TARGET = "~ORG~";

  // Normalize an incoming content field-set before persist:
  //   - CAMPUS OVERRIDE (campusId set): drop EMPTY fields ("" / [] / null / undefined) so a
  //     cleared field re-inherits the org default (stored SPARSE). Preserve the HIDDEN sentinel
  //     (an explicit blank, distinct from "not overridden"). Whole lists are kept as-is.
  //   - ORG DEFAULT (campusId null): keep provided fields as the church-wide baseline; still drop
  //     undefined so the blob stays clean.
  private static normalizeOverride(content: any, campusId: string | null): CampusContentFields {
    const out: CampusContentFields = {};
    const src: any = content ?? {};
    for (const key of CampusContentController.CONTENT_KEYS) {
      const val = (src as any)[key];
      if (val === undefined) continue; // never persist an undefined key
      if (val === HIDDEN) {
        (out as any)[key] = HIDDEN; // explicit hide — always preserved
        continue;
      }
      if (campusId !== null) {
        // Campus override: an empty value means "no override" → omit (inherit org default).
        const isEmpty = val === null || val === "" || (Array.isArray(val) && val.length === 0);
        if (isEmpty) continue;
      }
      (out as any)[key] = val;
    }
    return out;
  }
}
