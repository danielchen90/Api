import { controller, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";
import { VerifiedDomainGate } from "../helpers/VerifiedDomainGate.js";

// The send / status / settings surface for email campaigns (Phase 11, Plan 02).
// P12 owns the rich block-builder CRUD; this controller is the MINIMAL spine that
// fires the off-thread send and exposes progress + the sending-domain identity.
//
// NO sending happens here — /send only OCC-claims the campaign draft/scheduled→
// sending and returns 202. The actual SES sends run in CampaignSendWorker, drained
// by RailwayCron + the Lambda timer (SND-01 / DLV-03).
//
// Gates use the UNPREFIXED People permission convention (campus-auth-perms-
// unprefixed memory — a prefixed constant 401s every campus write). Per RESEARCH
// Open Q3 the IRREVERSIBLE mass send is deliberately gated stronger than a read:
// /send + /settings-write require People/Edit; /status + /domain-status +
// /settings-read require People/View.
@controller("/messaging/campaigns")
export class EmailCampaignController extends MessagingBaseController {

  // The single SES sending domain (email-provider-is-ses memory: huro.church sends
  // on Amazon SES). fromEmail on save MUST be on this domain; the live gate checks
  // the domain derived from fromEmail before every send.
  private static readonly SENDING_DOMAIN = "huro.church";

  // SND-01 + DLV-02 + DLV-04 — claim the campaign and hand off to the worker.
  @httpPost("/:id/send")
  public async send(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // Edit (not View) deliberately gates the irreversible mass send (Open Q3).
      if (!au.checkAccess({ contentType: "People", action: "Edit" })) return this.json({}, 401); // UNPREFIXED

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
      if (!au.checkAccess({ contentType: "People", action: "View" })) return this.json({}, 401); // UNPREFIXED
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

  // DLV-02 — sending-status banner data (Plan 03 banner).
  @httpGet("/domain-status")
  public async domainStatus(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "People", action: "View" })) return this.json({}, 401); // UNPREFIXED
      const settings = await this.repos.churchEmailSettings.loadByChurch(au.churchId);
      if (!settings || !settings.fromEmail) return this.json({ sendable: false, reason: "no-email-settings" });
      const domain = EmailCampaignController.domainOf(settings.fromEmail);
      return this.json(await VerifiedDomainGate.status(domain));
    });
  }

  // DLV-02 — read the church from-identity.
  @httpGet("/settings")
  public async getSettings(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "People", action: "View" })) return this.json({}, 401); // UNPREFIXED
      return this.json((await this.repos.churchEmailSettings.loadByChurch(au.churchId)) ?? {});
    });
  }

  // DLV-02 — upsert the church from-identity. Edit gate + strict validation.
  @httpPost("/settings")
  public async saveSettings(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "People", action: "Edit" })) return this.json({}, 401); // UNPREFIXED

      // Sanitize fromName — strip CR/LF (header injection, Pitfall 6).
      const fromName = (req.body?.fromName ?? "").replace(/[\r\n]+/g, " ").trim();
      const fromEmail = (req.body?.fromEmail ?? "").trim();
      const replyTo = (req.body?.replyTo ?? "").trim();

      // fromEmail must be a valid address ON the configured sending domain.
      if (!EmailCampaignController.isValidEmail(fromEmail)) {
        return this.json({ error: "invalid_from_email", code: "INVALID_FROM_EMAIL" }, 422);
      }
      if (EmailCampaignController.domainOf(fromEmail) !== EmailCampaignController.SENDING_DOMAIN) {
        return this.json({ error: "from_email_wrong_domain", code: "WRONG_DOMAIN" }, 422);
      }
      // replyTo, if set, must be a valid address (any domain).
      if (replyTo && !EmailCampaignController.isValidEmail(replyTo)) {
        return this.json({ error: "invalid_reply_to", code: "INVALID_REPLY_TO" }, 422);
      }

      const saved = await this.repos.churchEmailSettings.upsert(au.churchId, {
        fromName: fromName || undefined,
        fromEmail,
        replyTo: replyTo || undefined
      });
      return this.json(saved);
    });
  }

  // The part after the last '@' (lowercased). Empty if malformed.
  private static domainOf(email: string): string {
    const at = (email || "").lastIndexOf("@");
    return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
  }

  // Tiny syntactic address check (no library — apihelper has no isValidEmail;
  // RFC-perfect validation is a rabbit hole). Mirrors the Phase-10 resolver's
  // minimal validator intent.
  private static isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
  }
}
