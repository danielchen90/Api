import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

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
// The HTML wrapper is HURO-BRANDED and defined INLINE below (navy/gold/ivory —
// huro-visual-identity). We deliberately do NOT use apihelper's EmailTemplate.html:
// that template hard-codes a ChurchApps footer (support@churchapps.org, a support
// phone number, support.churchapps.org, and an "Explore Our Apps" list —
// FreeShow / Lessons.church / B1.church / Verse of the Day) which is upstream
// vendor branding with no app-level setting to change it. Inlining the wrapper
// here is the single place this footer is controlled.
export class TransactionalEmailSender {
  private static readonly client = new SESv2Client({ region: process.env.AWS_REGION || "us-east-1" });

  // Huro palette (huro-visual-identity): Navy #0B1D3A, Gold #D4A23A,
  // Slate #6B7280, Ivory #F5F6F7. Tokens {appLink} and {contents} are replaced
  // per-send; the footer carries only Huro branding — no ChurchApps content.
  private static readonly TEMPLATE = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title></title>
  <style>
    html, body { margin: 0 auto !important; padding: 0 !important; width: 100% !important; background: #F5F6F7; }
    * { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt !important; mso-table-rspace: 0pt !important; }
    table { border-spacing: 0 !important; border-collapse: collapse !important; margin: 0 auto !important; }
    img { -ms-interpolation-mode: bicubic; }
    a { text-decoration: none; color: #0B1D3A; }
    body { font-family: 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.7; color: #33404F; }
    h1, h2, h3 { font-family: 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #0B1D3A; margin-top: 0; font-weight: 600; }
    .brand a { color: #0B1D3A; font-size: 22px; font-weight: 700; letter-spacing: .3px; }
    .btn { padding: 12px 22px; display: inline-block; border-radius: 6px; }
    .btn-primary { background: #0B1D3A; color: #ffffff !important; font-weight: 600; }
    .footer { color: #6B7280; font-size: 12px; line-height: 18px; }
    .footer a { color: #6B7280; }
  </style>
</head>
<body width="100%" style="margin: 0; padding: 0 !important; mso-line-height-rule: exactly; background-color: #F5F6F7;">
  <center style="width: 100%; background-color: #F5F6F7;">
    <div style="max-width: 600px; margin: 0 auto;" class="email-container">
      <table align="center" role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: auto;">
        <tr>
          <td valign="top" style="background:#ffffff; border-top: 4px solid #D4A23A; padding: 2em 2.5em 0.5em 2.5em;">
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr><td class="brand" style="text-align: center;"><h1 style="margin:0;">{appLink}</h1></td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td valign="middle" style="background:#ffffff; padding: 1.5em 0 3em 0;">
            <table role="presentation" width="100%"><tr><td>
              <div style="padding: 0 2.5em; text-align: center; color:#33404F;">{contents}</div>
            </td></tr></table>
          </td>
        </tr>
      </table>
      <table align="center" role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: auto;">
        <tr>
          <td class="footer" style="text-align:center; padding: 20px 2.5em; background:#F5F6F7;">
            Sent with <a href="https://huro.church" style="color:#0B1D3A; font-weight:600;">Huro</a>
          </td>
        </tr>
      </table>
    </div>
  </center>
</body>
</html>`;

  static async sendTemplatedEmail(
    from: string,
    to: string,
    appName: string,
    appUrl: string,
    subject: string,
    contents: string,
    _templateFile = "EmailTemplate.html",
    replyTo?: string
  ): Promise<void> {
    if (!appName) appName = "Huro";
    if (!appUrl) appUrl = "https://huro.church";

    const html = TransactionalEmailSender.TEMPLATE
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
