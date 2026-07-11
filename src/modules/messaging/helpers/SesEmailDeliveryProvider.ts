import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { EmailSendRequest, EmailSendResult, IEmailDeliveryProvider } from "./IEmailDeliveryProvider.js";

// DLV-01 / DLV-05 — the SINGLE concrete implementation of the provider seam
// (Phase 11, Plan 01). SES v1 SendEmail. A later Resend swap replaces ONLY this
// file. Region is env-driven (AWS_REGION) and defaults to us-east-1 — that is
// where huro.church is verified with production sending access (confirmed live
// 2026-07-09; the earlier us-east-2 assumption was wrong — nothing is verified
// there). Keep in sync with VerifiedDomainGate.
export class SesEmailDeliveryProvider implements IEmailDeliveryProvider {
  private readonly ses = new SESClient({ region: process.env.AWS_REGION || "us-east-1" });

  public async send(r: EmailSendRequest): Promise<EmailSendResult> {
    try {
      // Pitfall 5: SES v1 has NO client idempotency token — do NOT invent one.
      // campaignId/recipientId are for FUTURE SNS correlation (Phase 13); the
      // exactly-once guarantee is the DB row-claim in Plan 02, NOT the transport.
      // TRK-02/TRK-05 (Phase 13, Plan 02): naming a configuration set is what makes
      // SES publish Open/Click/Delivery/Bounce/Complaint events to the SNS topic the
      // /messaging/tracking/sns webhook ingests (RESEARCH Pitfall 7 — WITHOUT a config
      // set, open/click events are NEVER emitted). Env-driven (SES_CONFIGURATION_SET,
      // provisioned per SES-SNS-TRACKING-RUNBOOK.md). Conditionally spread so an UNSET
      // env var degrades to a plain send instead of a 400 "config set does not exist".
      const out = await this.ses.send(new SendEmailCommand({
        Source: r.from,
        Destination: { ToAddresses: [r.to] },
        ReplyToAddresses: r.replyTo ? [r.replyTo] : undefined,
        ...(process.env.SES_CONFIGURATION_SET ? { ConfigurationSetName: process.env.SES_CONFIGURATION_SET } : {}),
        Message: {
          Subject: { Charset: "UTF-8", Data: r.subject },
          // DLV-05: pass BOTH an HTML part and a plain-text part. SES assembles
          // multipart/alternative itself — do NOT hand-roll MIME, do NOT add
          // nodemailer.
          Body: {
            Html: { Charset: "UTF-8", Data: r.html },
            Text: { Charset: "UTF-8", Data: r.text }
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
