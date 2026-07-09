import { controller, httpPost } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { CampusScopeHelper, normalizeAudience, resolveDescriptorPersonIds } from "../helpers/index.js";

/**
 * Scoped audience-resolution seam (Phase 10, AUD-01/02/03) — the ONE safe way to resolve an
 * audience to a people set. Mirrors LeadershipReportController EXACTLY for gating + scope
 * (People-View, UNPREFIXED; CampusScopeHelper.resolve server-side; scoped repo load), but returns
 * JSON — the { personId, email, campusId, mergeData }[] contract the messaging RecipientResolver
 * (Plan 02) consumes over the existing HTTP seam.
 *
 * WHY THIS EXISTS: no existing membership people-list endpoint (people, groupmembers, or
 * list-people routes) applies campus scope — routing audience resolution through them LEAKS every
 * campus to a Campus Admin, and a cross-campus recipient leak in a real send is unrecallable.
 * Messaging NEVER re-implements applyCampusScope; it calls THIS endpoint with the caller JWT so
 * membership re-derives the SAME scope server-side.
 *
 * The audience is type+target+filter — person IDs are OUTPUTS of the scoped resolve, NEVER a
 * client input. A campus/auxiliary target is a NARROWING applied WITHIN scope (an out-of-scope
 * target yields zero rows via applyCampusScope, never a leak — Pitfall 7).
 *
 * NOTE: the class name MUST be globally unique across ALL modules — inversify-express-utils
 * registers controllers by class name and crash-loops on a collision (LeadershipReportController
 * documents a real 502 from a duplicate). This is AudienceController (membership); the messaging
 * campaign controller in Plan 02 is the distinct CampaignAudienceController.
 */
@controller("/membership/audiences")
export class AudienceController extends MembershipBaseController {

  @httpPost("/resolve")
  public async resolve(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // 1. READ gate — People-View, UNPREFIXED (omit apiName). A read of people to email; not a write.
      if (!au.checkAccess({ contentType: "People", action: "View" })) return this.json({}, 401);

      // 2. SCOPE server-side from the caller JWT — NEVER from req.body (Pitfall 3).
      const scope = await CampusScopeHelper.resolve(au, this.repos);

      // 3. Descriptor from body (type+target+filter ONLY; personIds is never an input).
      const descriptor = normalizeAudience(req.body);
      const campusTargetId = descriptor.type === "campus" ? descriptor.targetId : undefined;

      // 4. Resolve the id narrowing (group/aux expansion + filterJson intersect); null = whole scoped church.
      const personIds = await resolveDescriptorPersonIds(au.churchId, descriptor, this.repos);

      // 5. Load people SCOPED — out-of-scope is structurally impossible (applyCampusScope in loadForAudience).
      const people = await this.repos.person.loadForAudience(au.churchId, scope, { campusTargetId, personIds });

      // 6. Map to the resolver contract.
      return (people as any[]).map((p) => ({
        personId: p.id,
        email: p.email,
        campusId: p.campusId,
        mergeData: { firstName: p.firstName, lastName: p.lastName, displayName: p.displayName }
      }));
    });
  }
}
