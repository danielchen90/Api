import { controller, httpGet, requestParam } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";
import { CampaignRecipient } from "../models/index.js";

// The tracking-reporting READ surface the Phase-13 Stats tab consumes (TRK-02 /
// TRK-03 / TRK-05). Exposes two authenticated endpoints over the stamps the 13-01
// SNS webhook writes:
//   GET /:id/stats      → headline engagement counts + a per-link click table
//   GET /:id/recipients → per-recipient engagement rows (drill-down + person link)
//
// COMPUTE-ON-READ: every count is RECOMPUTED from the per-recipient stamps +
// campaignEvents on each call (countByStatus / countEngagement / countClicksByLink)
// — there is NO stored rollup snapshot and NOTHING is incremented here. Because the
// webhook stamps first-seen and campaignEvents is idempotent on providerEventId, a
// redelivered SNS event can NEVER move a returned count (redelivery-safe by
// construction).
//
// This is a SEPARATE controller from EmailCampaignController / CampaignCrudController;
// inversify-express-utils registers by CLASS NAME, so three classes may share the
// "/messaging/campaigns" base as long as the class names differ and the routes don't
// collide. /:id/stats + /:id/recipients collide with none of the existing routes.
//
// AUTH: every endpoint gates on the UNPREFIXED "Campaigns" View permission
// (campus-auth-perms-unprefixed + messaging-campaign-endpoints-use-campaigns-perm
// memories — a prefixed constant, or the membership "People" perm, 401s under a
// MessagingApi-scoped JWT). All reads scope strictly to au.churchId.
@controller("/messaging/campaigns")
export class CampaignStatsController extends MessagingBaseController {

  // ── TRK-02 / TRK-05: headline counts + per-link click table ──
  // Compute-on-read: countByStatus gives sent/total, countEngagement gives the
  // engagement rollup, countClicksByLink gives the ranked link table. The frontend
  // computes rate % (denominator is a UI decision per RESEARCH §Pattern 8), so the
  // contract is the raw counts + linkClicks[].
  @httpGet("/:id/stats")
  public async stats(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed

      const byStatus = await this.repos.campaignRecipient.countByStatus(au.churchId, id);
      const eng = await this.repos.campaignRecipient.countEngagement(au.churchId, id);
      const linkClicks = await this.repos.campaignEvent.countClicksByLink(au.churchId, id);

      return this.json({
        sent: byStatus.sent,
        total: byStatus.total,
        delivered: eng.delivered,
        opened: eng.opened,
        clicked: eng.clicked,
        bounced: eng.bounced,
        complained: eng.complained,
        unsubscribed: eng.unsubscribed,
        linkClicks
      });
    });
  }

  // ── TRK-03: per-recipient drill-down rows ──
  // Optional ?status= filter. A literal status column value (sent/failed/pending/
  // sending/delivered/complained) is filtered at the DB via loadByCampaignAndStatus;
  // an ENGAGEMENT pseudo-status (opened/clicked/bounced/unsubscribed) that is not a
  // literal `status` value is filtered in JS on the corresponding stamp. Each row is
  // a lean DTO — personId is what the frontend deep-links on (RESEARCH Pattern 9);
  // name comes from the frozen mergeSnapshot display name, falling back to email. No
  // cross-module people lookup — everything stays within messaging.
  @httpGet("/:id/recipients")
  public async recipients(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess({ contentType: "Campaigns", action: "View" })) return this.json({}, 401); // MessagingApi-scoped, unprefixed

      const status = ((req.query?.status as string) ?? "").trim();
      const engagementPseudo = new Set(["opened", "clicked", "bounced", "unsubscribed"]);

      let rows: CampaignRecipient[];
      if (status && !engagementPseudo.has(status)) {
        // Literal status column value → filter at the DB.
        rows = await this.repos.campaignRecipient.loadByCampaignAndStatus(au.churchId, id, status);
      } else {
        rows = await this.repos.campaignRecipient.loadByCampaign(au.churchId, id);
        if (status && engagementPseudo.has(status)) {
          rows = rows.filter((r) => CampaignStatsController.hasStamp(r, status));
        }
      }

      const recipients = rows.map((r) => CampaignStatsController.toDto(r));
      return this.json({ recipients });
    });
  }

  // Does the recipient carry the engagement stamp implied by an engagement pseudo-status?
  private static hasStamp(r: CampaignRecipient, pseudo: string): boolean {
    switch (pseudo) {
      case "opened": return r.openedAt != null;
      case "clicked": return r.clickedAt != null;
      case "bounced": return r.bouncedAt != null;
      case "unsubscribed": return r.unsubscribedAt != null;
      default: return true;
    }
  }

  // Lean per-recipient DTO for the drill-down table. lastActivity = the most recent
  // engagement stamp present (falls back to createdAt). name is the frozen display
  // name (mergeSnapshot) else email — the frontend links name→/people/:personId only
  // when personId is present.
  private static toDto(r: CampaignRecipient): any {
    const stamps = [r.openedAt, r.clickedAt, r.bouncedAt, r.unsubscribedAt]
      .filter((d): d is Date => d != null)
      .map((d) => new Date(d).getTime());
    const lastActivity = stamps.length > 0 ? new Date(Math.max(...stamps)) : (r.createdAt ?? null);
    return {
      id: r.id,
      personId: r.personId,
      name: CampaignStatsController.displayName(r),
      email: r.email,
      status: r.status,
      openedAt: r.openedAt ?? null,
      clickedAt: r.clickedAt ?? null,
      bouncedAt: r.bouncedAt ?? null,
      lastActivity
    };
  }

  // Prefer the frozen mergeSnapshot display name (displayName, else firstName+lastName);
  // fall back to email. mergeSnapshot is a RAW JSON STRING (may be null/legacy).
  private static displayName(r: CampaignRecipient): string {
    try {
      if (r.mergeSnapshot) {
        const m = JSON.parse(r.mergeSnapshot);
        if (m?.displayName) return String(m.displayName);
        const full = [m?.firstName, m?.lastName].filter(Boolean).join(" ").trim();
        if (full) return full;
      }
    } catch {
      /* fall through to email */
    }
    return r.email ?? "";
  }
}
