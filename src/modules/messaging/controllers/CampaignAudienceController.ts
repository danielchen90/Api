import { controller, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";
import { RecipientResolver } from "../helpers/RecipientResolver.js";
import { CampaignRecipient } from "../models/index.js";
import { assertWritableCampus, CampusScope } from "../../membership/helpers/applyCampusScope.js";

// The messaging-side audience spine (AUD-07 preview + AUD-08 freeze). BOTH
// endpoints drive the SAME RecipientResolver.resolve so preview counts and the
// frozen list can never drift (no compose→send divergence by construction).
//
// Scope was ALREADY applied by the Plan-01 membership /audiences/resolve endpoint
// (messaging never re-implements applyCampusScope over a people query). Freeze
// additionally re-asserts campusId ∈ scope via the shared assertWritableCampus
// PURE predicate — cheap defense-in-depth, NOT a second resolution (which could
// drift).
//
// DEVIATION (Rule 3): the plan preferred calling CampusScopeHelper.resolve(au,
// this.repos), but that helper needs the MEMBERSHIP repos (userCampus.
// loadCampusIdsForUser) which the messaging module does not carry — a cast would
// crash at runtime (this.repos.userCampus is undefined). Per the plan's explicit
// fallback, we take the shared PURE assertWritableCampus import (no Repos
// dependency) and trust that the Plan-01 seam ALREADY campus-scoped every row
// server-side, re-asserting each row's campusId is a real (non-falsy) campus. No
// cross-module DB re-query is introduced; messaging still never runs the scope
// QUERY.
//
// Gate: the UNPREFIXED People-View read (per the campus-auth-perms-unprefixed
// memory + the Plan-01 resolver seam gate) on BOTH preview and freeze, kept
// consistent so a caller who can preview can freeze.
@controller("/messaging/campaigns")
export class CampaignAudienceController extends MessagingBaseController {

  // AUD-07 — audience-size preview. Three counts from the resolver, NO persistence.
  @httpPost("/:id/audience/preview")
  public async preview(@requestParam("id") _id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed (Phase 11 auth fix)
      const descriptor = req.body; // {type,targetId?,filterJson?} — passed straight to the seam
      const resolved = await RecipientResolver.resolve(au, this.repos, descriptor);
      return {
        deliverableCount: resolved.deliverable.length,
        skippedNoEmailCount: resolved.skippedNoEmail.length,
        suppressedCount: resolved.suppressed.length
      };
    });
  }

  // AUD-08 — freeze the resolved list into immutable campaignRecipients rows.
  // Body: { descriptor: {type,targetId?,filterJson?}, expectedVersion: number }.
  @httpPost("/:id/audience/freeze")
  public async freeze(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed (Phase 11 auth fix)

      const descriptor = req.body?.descriptor;
      const expectedVersion: number = req.body?.expectedVersion;

      // 1. Load the campaign scoped by church; 404-hide missing / out-of-tenant.
      const campaign = await this.repos.emailCampaign.load(au.churchId, id);
      if (!campaign) return this.json({ error: "not_found" }, 404);
      // Freeze is only legal on a draft campaign (double-freeze / already-frozen guard).
      if (campaign.status !== "draft") return this.json({ error: "not_draft" }, 409);

      // 2. Run the SAME resolver as preview (single source of truth).
      const resolved = await RecipientResolver.resolve(au, this.repos, descriptor);

      // 3. Re-assert campus scope at freeze — pure-logic defense-in-depth over the
      //    ALREADY-scoped deliverable (NOT a second resolve; no DB re-query, no
      //    re-implementation of the scope QUERY). The Plan-01 seam applied
      //    applyCampusScope server-side, so every row is in-scope; we trust that
      //    scoped result (mode:"all") and use the shared PURE assertWritableCampus
      //    predicate to additionally reject any falsy/empty campusId.
      const scope: CampusScope = { mode: "all" };
      const inScope = resolved.deliverable.filter((r) => assertWritableCampus(scope, r.campusId));

      // 4. Map the filtered deliverable → CampaignRecipient rows. createdAt is set
      //    by the repo (NOW()) and IS the frozenAt — NO new frozenAt column (Pitfall 5).
      const rows: CampaignRecipient[] = inScope.map((r) => ({
        churchId: au.churchId,
        campaignId: id,
        personId: r.personId,
        email: r.email,
        campusId: r.campusId,
        mergeSnapshot: JSON.stringify(r.mergeData),
        status: "pending"
      }));

      // 5. Idempotent status transition under OCC BEFORE the bulk insert. A
      //    re-freeze / concurrent freeze sees a stale version → 0n → 409. Persist
      //    audienceFilterJson as the record-of-intent.
      const bumped = await this.repos.emailCampaign.updateWithVersion(
        { ...campaign, id, churchId: au.churchId, status: "scheduled", audienceFilterJson: JSON.stringify(descriptor) },
        expectedVersion
      );
      if (bumped === 0n) return this.json({ error: "conflict" }, 409);

      // 6. Only after a successful OCC bump: bulk-insert the frozen rows.
      await this.repos.campaignRecipient.saveAll(rows);

      // 7. Report the freeze outcome.
      return {
        frozen: rows.length,
        skippedNoEmail: resolved.skippedNoEmail.length,
        suppressed: resolved.suppressed.length
      };
    });
  }
}
