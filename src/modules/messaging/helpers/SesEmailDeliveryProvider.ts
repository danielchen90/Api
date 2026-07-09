import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { EmailSendRequest, EmailSendResult, IEmailDeliveryProvider } from "./IEmailDeliveryProvider.js";

// DLV-01 / DLV-05 — the SINGLE concrete implementation of the provider seam
// (Phase 11, Plan 01). SES v1 SendEmail. A later Resend swap replaces ONLY this
// file. Region us-east-2 matches @churchapps/apihelper EmailHelper.getSESClient()
// (the repo's SES region — email-provider-is-ses memory: huro.church sends on SES).
export class SesEmailDeliveryProvider implements IEmailDeliveryProvider {
  private readonly ses = new SESClient({ region: "us-east-2" });

  public async send(r: EmailSendRequest): Promise<EmailSendResult> {
    try {
      // Pitfall 5: SES v1 has NO client idempotency token — do NOT invent one.
      // campaignId/recipientId are for FUTURE SNS correlation (Phase 13); the
      // exactly-once guarantee is the DB row-claim in Plan 02, NOT the transport.
      // ConfigurationSetName (for SNS event publishing) will be attached in P13 —
      // left off here on purpose.
      const out = await this.ses.send(new SendEmailCommand({
        Source: r.from,
        Destination: { ToAddresses: [r.to] },
        ReplyToAddresses: r.replyTo ? [r.replyTo] : undefined,
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
