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

  // SND-04 — stamp a future scheduledAt on an already-frozen (scheduled) campaign
  // under OCC. The B1Admin flow FREEZES the draft (draft→scheduled) BEFORE calling
  // this (see RESEARCH Open Q2), so we require status==="scheduled" and only WRITE
  // the scheduledAt instant here — status is unchanged. The 5-minute lead time is
  // enforced SERVER-SIDE (locked decision — the client's check is advisory only),
  // and the SAME verified-domain gate /send uses runs first so a campaign can never
  // be queued to an unverified/sandboxed domain. The poller (CampaignSendWorker) is
  // what eventually claims scheduled→sending once now >= scheduledAt.
  //
  // Route note: "/:id/schedule" is a "/:id/<verb>" SUB-path — MORE specific than
  // CampaignCrudController's "/:id" catch-all — so it coexists safely exactly like
  // "/:id/send" and "/:id/status" (see class header route-collision note).
  @httpPost("/:id/schedule")
  public async schedule(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // Send gate (not View) — scheduling queues an irreversible mass send (mirror /send).
      if (!au.checkAccess({ contentType: "Campaigns", action: "Send" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed (Phase 11 auth fix)

      // 1. Load church-scoped; 404-hide missing / out-of-tenant.
      const campaign = await this.repos.emailCampaign.load(au.churchId, id);
      if (!campaign) return this.json({ error: "not_found" }, 404);

      // 2. Parse the requested instant. scheduledAt is a UTC instant (Railway
      //    containers run UTC); B1Admin converts church-local wall-clock → UTC
      //    before sending. Reject anything unparseable.
      const when = new Date(req.body?.scheduledAt);
      if (isNaN(when.getTime())) return this.json({ error: "invalid_scheduledAt", code: "BAD_INPUT" }, 400);

      // 3. SERVER-SIDE 5-minute lead validation (locked — never trust the client).
      //    Compare UTC instants: reject a schedule less than 5 minutes in the future.
      const minLead = new Date(Date.now() + 5 * 60 * 1000);
      if (when.getTime() < minLead.getTime()) {
        return this.json({ error: "Scheduled time must be at least 5 minutes in the future", code: "LEAD_TIME" }, 422);
      }

      // 4. SAME verified-domain gate /send uses — a scheduled campaign can't be
      //    queued to an unverified / sandboxed domain (DLV-02 parity).
      const settings = await this.repos.churchEmailSettings.loadByChurch(au.churchId);
      if (!settings || !settings.fromEmail) {
        return this.json({ error: "No sender identity configured", code: "NO_EMAIL_SETTINGS" }, 422);
      }
      const domain = EmailCampaignController.domainOf(settings.fromEmail);
      if (!(await VerifiedDomainGate.isSendable(domain))) {
        return this.json({ error: "Sending domain not verified", code: "DOMAIN_UNVERIFIED" }, 422);
      }

      // 5. The campaign must already be frozen to "scheduled" (the B1Admin freeze
      //    ran first). draft/sending/sent/canceled → 409 (not schedulable here).
      if (campaign.status !== "scheduled") {
        return this.json({ error: "not_schedulable", code: "BAD_STATUS" }, 409);
      }

      // 6. OCC-stamp scheduledAt (status stays "scheduled"). updateWithVersion
      //    ALREADY persists scheduledAt (EmailCampaignRepo — no repo change). A
      //    concurrent edit/claim on the stale version → 0n → 409. Compare BigInt 0n.
      const bumped = await this.repos.emailCampaign.updateWithVersion(
        { ...campaign, scheduledAt: when },
        campaign.version
      );
      if (bumped === 0n) return this.json({ error: "conflict" }, 409);

      return this.json({ status: "scheduled", scheduledAt: when.toISOString() }, 200);
    });
  }

  // SND-05 — cancel a draft or scheduled campaign under OCC (→ canceled). This
  // closes the "before it is handed to the provider" boundary: once a campaign is
  // "sending", rows are being handed to SES, so cancel is REFUSED (409). The 0n
  // path is the cancel-vs-fire race the DB arbitrates — if the poller's
  // scheduled→sending claim landed first, cancel loses (409) and the send proceeds;
  // exactly-once (DLV-04) holds on both sides.
  //
  // Route note: "/:id/cancel" is a "/:id/<verb>" sub-path (safe like /:id/send).
  @httpPost("/:id/cancel")
  public async cancel(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "Send" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed (Phase 11 auth fix)

      const campaign = await this.repos.emailCampaign.load(au.churchId, id);
      if (!campaign) return this.json({ error: "not_found" }, 404);

      // Only legal while draft or scheduled (mirror /send's status guard). Once
      // sending/sent/canceled, cancel is refused — the send is already in flight.
      if (campaign.status !== "draft" && campaign.status !== "scheduled") {
        return this.json({ error: "not_cancelable", code: "BAD_STATUS" }, 409);
      }

      // OCC claim draft|scheduled → canceled. 0n ⇒ the poller's scheduled→sending
      // claim won the race (or a concurrent edit) → 409 (never a lost/double state).
      const bumped = await this.repos.emailCampaign.updateWithVersion(
        { ...campaign, status: "canceled" },
        campaign.version
      );
      if (bumped === 0n) return this.json({ error: "conflict" }, 409);

      return this.json({ status: "canceled" }, 200);
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
