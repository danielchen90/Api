import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { EmailHelper } from "@churchapps/apihelper";

// Transactional (one-to-one) email transport for membership flows — role
// invitations, account welcome codes, and password resets.
//
// WHY THIS EXISTS: the generic @churchapps/apihelper EmailHelper hard-codes the
// SES region to us-east-2, where NOTHING is verified for this deployment. Our
// huro.church domain has production sending access in us-east-1 (the same region
// the campaign pipeline's SesEmailDeliveryProvider targets). Routing membership
// email through apihelper therefore silently failed. This sender mirrors that
// proven campaign transport: SES v2, region us-east-1 (env-overridable), and the
// same SES_CONFIGURATION_SET so bounces/complaints land on the existing SNS
// tracking topic. Keep the region/config-set in sync with
// modules/messaging/helpers/SesEmailDeliveryProvider.ts.
//
// We still reuse apihelper's HTML templates (EmailHelper.readTemplate) so these
// emails keep the branded wrapper — only the transport changes.
export class TransactionalEmailSender {
  private static readonly client = new SESv2Client({ region: process.env.AWS_REGION || "us-east-1" });

  static async sendTemplatedEmail(
    from: string,
    to: string,
    appName: string,
    appUrl: string,
    subject: string,
    contents: string,
    templateFile = "EmailTemplate.html",
    replyTo?: string
  ): Promise<void> {
    if (!appName) appName = "Huro";
    if (!appUrl) appUrl = "https://huro.church";

    const template = EmailHelper.readTemplate(templateFile);
    const html = template
      .replace("{appLink}", "<a target='_blank' rel='noreferrer noopener' href=\"" + appUrl + "/\">" + appName + "</a>")
      .replace("{contents}", contents);
    const text = TransactionalEmailSender.htmlToText(html);

    await TransactionalEmailSender.client.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      ReplyToAddresses: replyTo ? [replyTo] : undefined,
      // Conditionally spread: an unset SES_CONFIGURATION_SET degrades to a plain
      // send rather than a 400 "config set does not exist".
      ...(process.env.SES_CONFIGURATION_SET ? { ConfigurationSetName: process.env.SES_CONFIGURATION_SET } : {}),
      Content: {
        Simple: {
          Subject: { Charset: "UTF-8", Data: subject },
          // Ship BOTH an HTML and a plain-text part; SES assembles the
          // multipart/alternative itself (better deliverability than HTML-only).
          Body: {
            Html: { Charset: "UTF-8", Data: html },
            Text: { Charset: "UTF-8", Data: text }
          }
        }
      }
    }));
  }

  // Cheap HTML→text fallback for the plain-text alternative part. Not a full
  // renderer — strips markup/entities and collapses whitespace, which is enough
  // for the short transactional bodies these emails carry.
  private static htmlToText(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
  }
}
