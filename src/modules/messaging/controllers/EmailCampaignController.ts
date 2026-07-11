import { controller, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";
import { VerifiedDomainGate } from "../helpers/VerifiedDomainGate.js";

// The send / status surface for email campaigns (Phase 11, Plan 02). P12 owns the
// rich block-builder CRUD; this controller is the MINIMAL spine that fires the
// off-thread send and exposes progress. (The from-identity /settings +
// /domain-status routes moved to CampaignCrudController — see note in the class.)
//
// NO sending happens here — /send only OCC-claims the campaign draft/scheduled→
// sending and returns 202. The actual SES sends run in CampaignSendWorker, drained
// by RailwayCron + the Lambda timer (SND-01 / DLV-03).
//
// Gates use the UNPREFIXED "Campaigns" permission convention (campus-auth-perms-
// unprefixed + messaging-campaign-endpoints-use-campaigns-perm memories). Per
// RESEARCH Open Q3 the IRREVERSIBLE mass send is deliberately gated stronger than a
// read: /send requires Campaigns/Send; /status requires Campaigns/View.
@controller("/messaging/campaigns")
export class EmailCampaignController extends MessagingBaseController {

  // NOTE: the from-identity settings routes (/settings GET+POST, /domain-status)
  // formerly lived here but were MOVED to CampaignCrudController (route-collision
  // fix): CampaignCrudController owns the "/:id" catch-all and — because inversify-
  // express-utils registers controllers ALPHABETICALLY by class name — registered
  // BEFORE this controller, so its "/:id" param route swallowed "/settings" and
  // "/domain-status" as campaign ids → 404. The static routes now sit before "/:id"
  // in the SAME controller, where declaration order guarantees they win.

  // SND-01 + DLV-02 + DLV-04 — claim the campaign and hand off to the worker.
  @httpPost("/:id/send")
  public async send(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // Edit (not View) deliberately gates the irreversible mass send (Open Q3).
      if (!au.checkAccess({ contentType: "Campaigns", action: "Send" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed (Phase 11 auth fix)

      // 1. Load campaign church-scoped; 404-hide missing / out-of-tenant.
      const campaign = await this.repos.emailCampaign.load(au.churchId, id);
      if (!campaign) return this.json({ error: "not_found" }, 404);

      // 2. Derive the sending domain from the church's from-identity.
      const settings = await this.repos.churchEmailSettings.loadByChurch(au.churchId);
      if (!settings || !settings.fromEmail) {
        return this.json({ error: "No sender identity configured", code: "NO_EMAIL_SETTINGS" }, 422);
      }
      const domain = EmailCampaignController.domainOf(settings.fromEmail);

      // 3. LIVE gate (DLV-02) — hard block an unverified / sandboxed domain with a
      //    clear error + machine code BEFORE the OCC claim. Never a surprise: the
      //    Plan 03 banner warns proactively via /domain-status.
      if (!(await VerifiedDomainGate.isSendable(domain))) {
        return this.json({ error: "Sending domain not verified", code: "DOMAIN_UNVERIFIED" }, 422);
      }

      // 4. Only a draft or scheduled campaign may be sent (already sending/sent/
      //    canceled → 409).
      if (campaign.status !== "draft" && campaign.status !== "scheduled") {
        return this.json({ error: "not_sendable", code: "BAD_STATUS" }, 409);
      }

      // 5. OCC claim draft/scheduled→sending. A double-click / concurrent scheduler
      //    loses on the stale version → 0n → 409 (DLV-04 exactly-once at the
      //    campaign level). The worker sends off-thread.
      const bumped = await this.repos.emailCampaign.updateWithVersion(
        { ...campaign, status: "sending" },
        campaign.version
      );
      if (bumped === 0n) return this.json({ error: "conflict" }, 409);

      return this.json({ status: "sending", recipientCount: campaign.recipientCount }, 202);
    });
  }

  // SND-06 — X-of-N progress for the confirm + live progress UI (Plan 03).
  @httpGet("/:id/status")
  public async status(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed (Phase 11 auth fix)
      const campaign = await this.repos.emailCampaign.load(au.churchId, id);
      if (!campaign) return this.json({ error: "not_found" }, 404);
      // Live per-status breakdown supplements the stored rollup counters.
      const counts = await this.repos.campaignRecipient.countByStatus(au.churchId, id);
      return {
        status: campaign.status,
        recipientCount: campaign.recipientCount,
        sentCount: campaign.sentCount,
        failedCount: campaign.failedCount,
        counts
      };
    });
  }

  // The part after the last '@' (lowercased). Empty if malformed.
  // Used by /send's live verified-domain gate (the /settings + /domain-status
  // consumers moved to CampaignCrudController with their own copy of this helper).
  private static domainOf(email: string): string {
    const at = (email || "").lastIndexOf("@");
    return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
  }
}
