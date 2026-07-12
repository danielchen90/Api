import { controller, httpPost, httpGet } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";
import { UnsubscribeTokenHelper } from "../helpers/UnsubscribeTokenHelper.js";

// ── Public, no-login preference / unsubscribe center (Phase 14, CMP-01 / CMP-05) ──
//
// EVERY endpoint here is ANONYMOUS — mailbox providers and logged-out members
// carry NO auth header. The signed HMAC token (UnsubscribeTokenHelper) IS the
// auth, and the TENANT is derived from the token payload — it is NEVER read from
// a request param. No endpoint uses actionWrapper (that requires a JWT); each
// uses raw express req/res + res.send() (the AssignmentController.public/respond
// precedent), serving inline HTML from the Api with no B1App page / templating.
//
// DISTINCT base route `/messaging/unsubscribe` (NOT `/messaging/campaigns`) so it
// does NOT collide with CampaignCrudController's `/:id` catch-all (RESEARCH
// Pitfall 1 / the route-collision memory). Inversify registers by unique class
// name — `UnsubscribeController` is globally unique across messaging controllers.
//
// CONTRACT — POST /one-click is 200-ALWAYS (RFC 8058 §4 / RESEARCH Pitfall 4):
// a mailbox provider treats ANY non-2xx as a failed unsubscribe, so we return 200
// on a valid, invalid, expired, missing, or errored token — never leaking token
// validity, never 4xx-ing a receiver. The URL token is sufficient; the POST body
// is not read.
//
// RESUBSCRIBE is REASON-SCOPED: remove(churchId,email,["unsubscribe"]) (Plan 01)
// undoes ONLY a member's own opt-out — it can NEVER clear a reason="bounce" or
// "complaint" suppression (permanent deliverability facts).

@controller("/messaging/unsubscribe")
export class UnsubscribeController extends MessagingBaseController {

  // Inline HTML shell — Huro navy/gold, centered, self-contained (no app CSS).
  private page(title: string, body: string): string {
    return (
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
      `<body style="margin:0;background:#F5F6F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1F2A3D;">` +
      `<div style="max-width:480px;margin:60px auto;padding:32px 28px;background:#ffffff;border-radius:12px;` +
      `box-shadow:0 1px 4px rgba(11,29,58,0.08);text-align:center;">` +
      `<h1 style="margin:0 0 8px;font-size:20px;color:#0B1D3A;">${title}</h1>` +
      `${body}` +
      `<p style="margin:24px 0 0;font-size:12px;color:#6B7280;">Sent with Huro</p>` +
      `</div></body></html>`
    );
  }

  // 1. RFC 8058 one-click machine endpoint — mailbox providers POST here.
  //    ALWAYS 200, even on an invalid/expired/missing token or an internal error.
  @httpPost("/one-click")
  public async oneClick(req: express.Request, res: express.Response): Promise<void> {
    try {
      const payload = UnsubscribeTokenHelper.verify(req.query.token as string);
      // Do NOT read the POST body — the URL token is sufficient (RFC 8058 §4).
      if (payload) {
        const { churchId, email, campaignId } = payload;
        await this.repos.emailSuppression.add({ churchId, email, reason: "unsubscribe", sourceCampaignId: campaignId });
      }
    } catch (e) {
      // Swallow — a mailbox provider must never see a non-2xx (Pitfall 4).
      console.error("[unsubscribe/one-click] failed:", e);
    }
    // Contractually 200-always, empty body.
    res.status(200).send("");
  }

  // 2. Human-facing preference / confirmation page.
  @httpGet("/")
  public async preference(req: express.Request, res: express.Response): Promise<void> {
    try {
      const payload = UnsubscribeTokenHelper.verify(req.query.token as string);
      if (!payload) {
        res.status(200).send(this.page("Link expired", `<p style="color:#6B7280;">This unsubscribe link is no longer valid.</p>`));
        return;
      }

      const { churchId, email } = payload;
      const token = encodeURIComponent(req.query.token as string);
      const suppressed = await this.repos.emailSuppression.isSuppressed(churchId, email);
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      const goldButton = "display:inline-block;margin-top:16px;padding:10px 22px;background:#D4A23A;color:#0B1D3A;" +
        "border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;";
      const navyButton = "display:inline-block;margin-top:16px;padding:10px 22px;background:#0B1D3A;color:#ffffff;" +
        "border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;";

      let body: string;
      if (suppressed) {
        // Already opted out — offer resubscribe only.
        body =
          `<p style="color:#6B7280;">You're currently unsubscribed from church emails at ` +
          `<strong>${esc(email)}</strong>. You will not receive further emails.</p>` +
          `<form method="post" action="/messaging/unsubscribe/resubscribe?token=${token}">` +
          `<button type="submit" style="${goldButton}">Resubscribe</button></form>`;
      } else {
        // Still subscribed — offer unsubscribe-from-all (+ a resubscribe affordance).
        body =
          `<p style="color:#6B7280;">Manage church email preferences for ` +
          `<strong>${esc(email)}</strong>.</p>` +
          `<form method="post" action="/messaging/unsubscribe/one-click?token=${token}">` +
          `<button type="submit" style="${navyButton}">Unsubscribe from all emails</button></form>` +
          `<form method="post" action="/messaging/unsubscribe/resubscribe?token=${token}" style="margin-top:4px;">` +
          `<button type="submit" style="${goldButton}">Resubscribe</button></form>`;
      }

      res.status(200).send(this.page("Email preferences", body));
    } catch (e) {
      console.error("[unsubscribe/preference] failed:", e);
      res.status(200).send(this.page("Something went wrong", `<p style="color:#6B7280;">Please try the link again.</p>`));
    }
  }

  // 3. Resubscribe — reason-scoped remove of the member's own opt-out ONLY.
  @httpPost("/resubscribe")
  public async resubscribe(req: express.Request, res: express.Response): Promise<void> {
    try {
      const payload = UnsubscribeTokenHelper.verify(req.query.token as string);
      if (!payload) {
        res.status(200).send(this.page("Link expired", `<p style="color:#6B7280;">This link is no longer valid.</p>`));
        return;
      }
      const { churchId, email } = payload;
      // Reason-scoped: undoes ONLY reason="unsubscribe" — never bounce/complaint (Plan 01).
      await this.repos.emailSuppression.remove(churchId, email, ["unsubscribe"]);
      res.status(200).send(this.page(
        "You're resubscribed",
        `<p style="color:#6B7280;">You'll receive church emails again. You can unsubscribe anytime.</p>`
      ));
    } catch (e) {
      console.error("[unsubscribe/resubscribe] failed:", e);
      res.status(200).send(this.page("Something went wrong", `<p style="color:#6B7280;">Please try the link again.</p>`));
    }
  }
}
