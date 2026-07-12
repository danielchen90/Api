import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { EmailSendRequest, EmailSendResult, IEmailDeliveryProvider } from "./IEmailDeliveryProvider.js";

// DLV-01 / DLV-05 — the SINGLE concrete implementation of the provider seam
// (Phase 11, Plan 01). MIGRATED SES v1 → SES v2 (Phase 14, Plan 02): the v2
// SendEmailCommand exposes Content.Simple.Headers, which is how we attach the
// RFC 8058 List-Unsubscribe / List-Unsubscribe-Post:One-Click headers CMP-01
// needs. The v1 SendEmailCommand CANNOT set custom headers without hand-rolling
// raw MIME — which this file explicitly forbids (see the Body note below); the
// v2 Headers field is the sanctioned alternative to raw MIME. A later Resend
// swap replaces ONLY this file. Region is env-driven (AWS_REGION) and defaults
// to us-east-1 — that is where huro.church is verified with production sending
// access (confirmed live 2026-07-09; the earlier us-east-2 assumption was wrong
// — nothing is verified there). Keep in sync with VerifiedDomainGate.
export class SesEmailDeliveryProvider implements IEmailDeliveryProvider {
  private readonly ses = new SESv2Client({ region: process.env.AWS_REGION || "us-east-1" });

  public async send(r: EmailSendRequest): Promise<EmailSendResult> {
    try {
      // Pitfall 5: SES has NO client idempotency token — do NOT invent one.
      // campaignId/recipientId are for SNS correlation (Phase 13); the
      // exactly-once guarantee is the DB row-claim in the worker, NOT the transport.
      // CMP-01: RFC 8058 one-click unsubscribe. When the worker supplies a
      // per-recipient signed listUnsubscribeUrl, ship BOTH headers together —
      // List-Unsubscribe (one HTTPS URI in angle brackets) AND
      // List-Unsubscribe-Post: List-Unsubscribe=One-Click (MUST be exactly this
      // pair). Absent → an EMPTY Headers array, i.e. a plain send (no regression
      // for test-sends / any caller that doesn't set the URL). The URL is
      // HMAC-derived base64url (inherently CR/LF-free) so no header sanitization
      // is needed here (RESEARCH Pitfall 5); fromName/replyTo sanitization stays
      // in CampaignSendWorker.
      const headers = r.listUnsubscribeUrl ? [
        { Name: "List-Unsubscribe", Value: `<${r.listUnsubscribeUrl}>` },        // RFC 8058: one HTTPS URI in angle brackets
        { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" }   // RFC 8058: MUST be exactly this pair
      ] : [];
      // TRK-02/TRK-05 (Phase 13, Plan 02): naming a configuration set is what makes
      // SES publish Open/Click/Delivery/Bounce/Complaint events to the SNS topic the
      // /messaging/tracking/sns webhook ingests (RESEARCH Pitfall 7 — WITHOUT a config
      // set, open/click events are NEVER emitted). Env-driven (SES_CONFIGURATION_SET,
      // provisioned per SES-SNS-TRACKING-RUNBOOK.md). Conditionally spread so an UNSET
      // env var degrades to a plain send instead of a 400 "config set does not exist".
      // This migration PRESERVES that dependency — Phase 13 tracking still works.
      const out = await this.ses.send(new SendEmailCommand({
        FromEmailAddress: r.from,
        Destination: { ToAddresses: [r.to] },
        ReplyToAddresses: r.replyTo ? [r.replyTo] : undefined,
        ...(process.env.SES_CONFIGURATION_SET ? { ConfigurationSetName: process.env.SES_CONFIGURATION_SET } : {}),
        Content: {
          Simple: {
            Subject: { Charset: "UTF-8", Data: r.subject },
            // DLV-05: pass BOTH an HTML part and a plain-text part. SES assembles
            // multipart/alternative itself — do NOT hand-roll MIME, do NOT add
            // nodemailer. (The v2 Headers array below is the sanctioned way to set
            // custom headers WITHOUT raw MIME.)
            Body: {
              Html: { Charset: "UTF-8", Data: r.html },
              Text: { Charset: "UTF-8", Data: r.text }
            },
            Headers: headers
          }
        }
      }));
      return { success: true, providerMessageId: out.MessageId };
    } catch (e: any) {
      // Transient (throttle / 5xx) → retryable; anything else → permanent.
      const retryable = e?.name === "Throttling" || (e?.$metadata?.httpStatusCode >= 500);
      return { success: false, error: e?.message ?? String(e), retryable };
    }
  }
}
