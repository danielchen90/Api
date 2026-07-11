import { controller, httpPost } from "inversify-express-utils";
import express from "express";
import * as https from "node:https";
import MessageValidator from "sns-validator";
import { MessagingBaseController } from "./MessagingBaseController.js";

// ── Anonymous SNS → SES tracking webhook (Phase 13, TRK-01 / TRK-04) ──
//
// SES publishes Delivery/Open/Click/Bounce/Complaint notifications to an SNS
// topic; SNS POSTs them here. This endpoint is ANONYMOUS (no JWT — SNS carries
// no auth header) and FORGERY-PROOF: the SNS cryptographic signature is verified
// FIRST, and the tenant (churchId) is DERIVED from the recipient row via the
// provider messageId — it is NEVER read from the request body. It is also
// REDELIVERY-SAFE: SNS retries aggressively and at-least-once, so every side
// effect is guarded by the idempotent campaignEvents insert (UNIQUE
// providerEventId) — a duplicate event short-circuits before any stamp/suppress.
//
// Response contract (Pitfall: SNS treats any non-2xx as failure and retries):
//   - invalid signature            → 403 (do NOT process)
//   - SubscriptionConfirmation     → confirm + 200
//   - unknown / test-send messageId → 200 (drop, never 500)
//   - duplicate event              → 200 (side effects already applied)
//   - everything else              → 200
//
// NO rollup counter mutation here — campaign stats are compute-on-read (Plan 03).

// Module-level singleton — the validator is stateless (fetches + caches SNS
// signing certs by URL); one instance serves every request.
const validator = new MessageValidator();

@controller("/messaging/tracking")
export class SnsTrackingController extends MessagingBaseController {

  @httpPost("/sns")
  public async sns(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      // 1. Coerce the raw body (app.ts delivers text/plain unparsed — Pitfall 4).
      let body: any;
      try {
        body = typeof req.body === "string"
          ? JSON.parse(req.body)
          : Buffer.isBuffer(req.body)
            ? JSON.parse(req.body.toString("utf8"))
            : req.body;
      } catch {
        return this.json({}, 200); // unparseable — drop, never 500
      }
      if (!body || typeof body !== "object") return this.json({}, 200);

      // 2. Verify the SNS signature FIRST — before ANY processing.
      try {
        await new Promise<void>((ok, no) => validator.validate(body, (e) => (e ? no(e) : ok())));
      } catch {
        return this.json({ error: "invalid signature" }, 403);
      }

      // 3. Subscription lifecycle handshakes.
      if (body.Type === "SubscriptionConfirmation") {
        if (body.SubscribeURL) {
          await new Promise<void>((r) => https.get(body.SubscribeURL, () => r()).on("error", () => r()));
        }
        return this.json({}, 200);
      }
      if (body.Type === "UnsubscribeConfirmation") return this.json({}, 200);
      if (body.Type !== "Notification") return this.json({}, 200);

      // 4. Unwrap the double envelope (SNS Notification → SES event JSON string).
      let ev: any;
      try {
        ev = JSON.parse(body.Message);
      } catch {
        return this.json({}, 200);
      }
      // SES uses `eventType` on config-set events, `notificationType` on identity
      // notifications — accept either (Pitfall 5).
      const type: string | undefined = ev.eventType ?? ev.notificationType;
      const messageId: string | undefined = ev.mail?.messageId;
      if (!messageId) return this.json({}, 200); // nothing to correlate — drop

      // 5. Resolve the TENANT from the recipient row (the request carries none).
      const recip = await this.repos.campaignRecipient.loadByProviderMessageIdAnyChurch(messageId);
      if (!recip) return this.json({}, 200); // unknown / test-send / expired — drop
      const { churchId, campaignId, id: recipientId, email } = recip;

      // 6. Synthesize a stable, redelivery-collapsing event id.
      const evTs: string | undefined = ev[type?.toLowerCase() ?? ""]?.timestamp ?? ev.mail?.timestamp;
      const link: string = type === "Click" ? (ev.click?.link ?? "") : "";
      const providerEventId = [messageId, type, evTs, link].filter(Boolean).join(":");

      // 7. Idempotent append — a duplicate collides on UNIQUE providerEventId and
      // returns false; side effects were already applied on the first delivery.
      const isNew = await this.repos.campaignEvent.insert({
        churchId,
        campaignId,
        recipientId,
        eventType: type,
        payloadJson: body.Message,
        providerEventId
      });
      if (!isNew) return this.json({}, 200); // duplicate — the idempotency guard

      // 8. First-seen side effects (partial patch — never clobbers earlier stamps).
      const ts = new Date(evTs as string);
      switch (type) {
        case "Delivery":
          await this.repos.campaignRecipient.updateStatus(churchId, recipientId, { status: "delivered" });
          break;
        case "Open":
          await this.repos.campaignRecipient.updateStatus(churchId, recipientId, { openedAt: ts });
          break;
        case "Click":
          await this.repos.campaignRecipient.updateStatus(churchId, recipientId, { clickedAt: ts, openedAt: ts });
          break;
        case "Bounce":
          await this.repos.campaignRecipient.updateStatus(churchId, recipientId, { status: "bounced", bouncedAt: ts });
          // ONLY a Permanent (hard) bounce suppresses. Transient/soft NEVER does.
          if (ev.bounce?.bounceType === "Permanent") {
            await this.repos.emailSuppression.add({ churchId, email, reason: "bounce", sourceCampaignId: campaignId });
          }
          break;
        case "Complaint":
          await this.repos.campaignRecipient.updateStatus(churchId, recipientId, { status: "complained" });
          // A complaint ALWAYS suppresses (church-wide).
          await this.repos.emailSuppression.add({ churchId, email, reason: "complaint", sourceCampaignId: campaignId });
          break;
        default:
          break; // unknown event type — logged (event row) but no stamp
      }

      return this.json({}, 200);
    });
  }
}
