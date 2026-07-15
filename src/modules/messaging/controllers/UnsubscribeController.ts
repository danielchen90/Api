import { controller, httpPost, httpGet } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";
import { UnsubscribeTokenHelper } from "../helpers/UnsubscribeTokenHelper.js";
import { Repos } from "../repositories/index.js";

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

  // Hydrate this.repos for a RAW-express handler.
  //
  // BUG (Phase 14, live): this.repos is populated ONLY inside actionWrapper/
  // actionWrapperAnon (BaseController). These endpoints deliberately use raw
  // express req/res with NO actionWrapper (the token IS the auth), so this.repos
  // was `undefined` and the FIRST repo call — isSuppressed() on a VALID token —
  // threw `Cannot read properties of undefined (reading 'emailSuppression')`,
  // hitting the catch and rendering "Something went wrong" for a good link.
  // (An invalid token short-circuits at verify()→null BEFORE any repo call, so it
  // still rendered "Link expired" — which is why only real tokens broke.)
  // getRepos() delegates to RepoManager; getDb() itself is a module-level
  // KyselyPool singleton independent of DI, so this is a plain hydration.
  private async hydrateRepos(): Promise<void> {
    if (!this.repos) this.repos = await this.getRepos<Repos>();
  }

  // Inline HTML shell — Huro navy/gold, centered, self-contained (no app CSS).
  // Every public unsubscribe/resubscribe page shares this shell + "Sent with Huro"
  // footer so the pre-action preference page and the two post-action confirmation
  // pages are visually identical.
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

  // Shared Huro button styles — gold (primary/return) + navy (secondary/opt-out).
  private static readonly GOLD_BUTTON =
    "display:inline-block;margin-top:16px;padding:10px 22px;background:#D4A23A;color:#0B1D3A;" +
    "border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;";
  private static readonly NAVY_BUTTON =
    "display:inline-block;margin-top:16px;padding:10px 22px;background:#0B1D3A;color:#ffffff;" +
    "border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;";

  // Minimal HTML-escape for interpolated email addresses.
  private esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Gentle "this link has expired" page — shared by every handler when a token is
  // invalid/expired. Never a stack trace, never a 4xx (one-click stays 200-always).
  private expiredPage(): string {
    return this.page(
      "This link has expired",
      `<p style="color:#6B7280;">This link is no longer valid. Open a recent email from us ` +
      `to manage your preferences.</p>`
    );
  }

  // 1. RFC 8058 one-click machine endpoint AND human unsubscribe-form target.
  //    ALWAYS 200, even on an invalid/expired/missing token or an internal error.
  //
  //    Returning an HTML BODY is safe for mailbox providers: Gmail/Yahoo one-click
  //    check ONLY the 2xx status and ignore the body (RFC 8058 §4), so the same
  //    200-with-HTML serves both the machine POST and the human form submit. NO
  //    redirect, NO non-2xx — that would break the machine contract (Pitfall 4).
  @httpPost("/one-click")
  public async oneClick(req: express.Request, res: express.Response): Promise<void> {
    try {
      const rawToken = req.query.token as string;
      const payload = UnsubscribeTokenHelper.verify(rawToken);
      // Do NOT read the POST body — the URL token is sufficient (RFC 8058 §4).
      if (!payload) {
        // Invalid/expired/missing — gentle page, still 200 (machine sees only 2xx).
        res.status(200).send(this.expiredPage());
        return;
      }

      await this.hydrateRepos();
      const { churchId, email, campaignId } = payload;
      await this.repos.emailSuppression.add({ churchId, email, reason: "unsubscribe", sourceCampaignId: campaignId });

      // Engagement stamp (Phase 17, TRK-02/TRK-03): stamp unsubscribedAt on the
      // matching recipient row so the per-campaign `unsubscribed` count + the
      // ?status=unsubscribed drill-down reflect real opt-outs. A lookup miss
      // (recip undefined) is a SAFE NO-OP — never throw, never 4xx: the one-click
      // endpoint MUST stay 200-always (RFC 8058). Attribution: campaignId (when the
      // token carries one) narrows to that exact send; otherwise the newest row for
      // the address is stamped. NEVER pass the email as the row id.
      const recip = await this.repos.campaignRecipient.loadLatestByEmail(churchId, email, campaignId);
      if (recip?.id) await this.repos.campaignRecipient.updateStatus(churchId, recip.id, { unsubscribedAt: new Date() });

      // Warm, on-brand human confirmation — with a one-click Resubscribe right here.
      const token = encodeURIComponent(rawToken);
      const body =
        `<p style="color:#4B5563;">We've stopped sending church emails to ` +
        `<strong>${this.esc(email)}</strong> — no hard feelings, and thanks for the time ` +
        `you shared with us.</p>` +
        `<p style="color:#6B7280;">If the timing's better down the road, you're always ` +
        `welcome back. It only takes one click.</p>` +
        `<form method="post" action="/messaging/unsubscribe/resubscribe?token=${token}">` +
        `<button type="submit" style="${UnsubscribeController.GOLD_BUTTON}">Resubscribe</button></form>`;
      res.status(200).send(this.page("You're unsubscribed", body));
    } catch (e) {
      // Swallow — a mailbox provider must never see a non-2xx (Pitfall 4). Even the
      // error path returns 200-with-HTML, never a stack trace.
      console.error("[unsubscribe/one-click] failed:", e);
      res.status(200).send(this.expiredPage());
    }
  }

  // 2. Human-facing preference / confirmation page.
  @httpGet("/")
  public async preference(req: express.Request, res: express.Response): Promise<void> {
    try {
      const payload = UnsubscribeTokenHelper.verify(req.query.token as string);
      if (!payload) {
        res.status(200).send(this.expiredPage());
        return;
      }

      await this.hydrateRepos();
      const { churchId, email } = payload;
      const token = encodeURIComponent(req.query.token as string);
      const suppressed = await this.repos.emailSuppression.isSuppressed(churchId, email);

      let body: string;
      if (suppressed) {
        // Already opted out — offer resubscribe only.
        body =
          `<p style="color:#6B7280;">You're currently unsubscribed from church emails at ` +
          `<strong>${this.esc(email)}</strong>, so we're not sending anything your way. ` +
          `Changed your mind? You're always welcome back.</p>` +
          `<form method="post" action="/messaging/unsubscribe/resubscribe?token=${token}">` +
          `<button type="submit" style="${UnsubscribeController.GOLD_BUTTON}">Resubscribe</button></form>`;
      } else {
        // Still subscribed — offer unsubscribe-from-all (+ a resubscribe affordance).
        body =
          `<p style="color:#6B7280;">Manage the church emails we send to ` +
          `<strong>${this.esc(email)}</strong>. You're in control — update whenever you like.</p>` +
          `<form method="post" action="/messaging/unsubscribe/one-click?token=${token}">` +
          `<button type="submit" style="${UnsubscribeController.NAVY_BUTTON}">Unsubscribe from all emails</button></form>` +
          `<form method="post" action="/messaging/unsubscribe/resubscribe?token=${token}" style="margin-top:4px;">` +
          `<button type="submit" style="${UnsubscribeController.GOLD_BUTTON}">Resubscribe</button></form>`;
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
      const rawToken = req.query.token as string;
      const payload = UnsubscribeTokenHelper.verify(rawToken);
      if (!payload) {
        res.status(200).send(this.expiredPage());
        return;
      }
      await this.hydrateRepos();
      const { churchId, email } = payload;
      // Reason-scoped: undoes ONLY reason="unsubscribe" — never bounce/complaint (Plan 01).
      await this.repos.emailSuppression.remove(churchId, email, ["unsubscribe"]);

      // Warm "Welcome back" — with an affordance to opt out again if they change their mind.
      const token = encodeURIComponent(rawToken);
      const body =
        `<p style="color:#4B5563;">Great to have you back! We'll start sending church emails ` +
        `to <strong>${this.esc(email)}</strong> again.</p>` +
        `<p style="color:#6B7280;">Changed your mind? You can unsubscribe again anytime.</p>` +
        `<form method="post" action="/messaging/unsubscribe/one-click?token=${token}">` +
        `<button type="submit" style="${UnsubscribeController.NAVY_BUTTON}">Unsubscribe from all emails</button></form>`;
      res.status(200).send(this.page("Welcome back", body));
    } catch (e) {
      console.error("[unsubscribe/resubscribe] failed:", e);
      res.status(200).send(this.page("Something went wrong", `<p style="color:#6B7280;">Please try the link again.</p>`));
    }
  }
}
