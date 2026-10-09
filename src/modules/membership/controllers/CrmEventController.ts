import { controller, httpDelete, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { AuthenticatedUser } from "@churchapps/apihelper";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { Permissions } from "../helpers/index.js";
import { CampusScopeHelper } from "../helpers/CampusScopeHelper.js";
import { AuditLogHelper } from "../helpers/AuditLogHelper.js";
import { PublicFormSubmissionHelper } from "../helpers/PublicFormSubmissionHelper.js";
import { CrmEventService, EventError, eventUrl } from "../helpers/crm/CrmEventService.js";
import { CrmEventMailer } from "../helpers/crm/CrmEventMailer.js";
import { CrmAiError } from "../helpers/crm/CrmAiService.js";

/**
 * The CRM event planner.
 *   /membership/crm/events/...         staff (People View to read, People Edit to change; org-wide only)
 *   /membership/crm/public/events/...  the public landing page + registration (no sign-in)
 */
@controller("/membership/crm")
export class CrmEventController extends MembershipBaseController {
  private run(req: express.Request, res: express.Response, edit: boolean, fn: (au: AuthenticatedUser, svc: CrmEventService) => Promise<any>) {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(edit ? Permissions.people.edit : Permissions.people.view)) return this.json({ error: "forbidden" }, 401);
      if ((await CampusScopeHelper.resolve(au, this.repos)).mode !== "all") return this.json({ error: "org_wide_only" }, 403);
      try {
        return await fn(au, new CrmEventService(this.repos));
      } catch (e: any) {
        if (e instanceof EventError || e instanceof CrmAiError) return this.json({ error: e.code }, e.status);
        throw e;
      }
    });
  }

  private async withEvent(au: AuthenticatedUser, id: string) {
    const ev = await this.repos.crmEvent.load(au.churchId, id);
    if (!ev) throw new EventError(404, "not_found");
    return ev;
  }

  // ── staff ──
  @httpGet("/events")
  public async list(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, false, async (au) => (await this.repos.crmEvent.list(au.churchId)).map((e: any) => ({ ...e, url: eventUrl(e.slug) })));
  }

  @httpPost("/events")
  public async create(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, true, async (au, svc) => {
      const id = await svc.create(au.churchId, req.body, au.id);
      AuditLogHelper.log(this.repos, au.churchId, au.id, "crm", "event_created", "crmEvent", id, undefined, AuditLogHelper.getClientIp(req));
      return { id };
    });
  }

  @httpGet("/events/:id")
  public async get(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, false, async (au) => {
      const ev = await this.withEvent(au, id);
      const emails = await this.repos.crmEvent.emails(au.churchId, id);
      const stats = await this.repos.crmEvent.sendStats(emails.map((e: any) => e.id));
      return {
        ...ev,
        url: eventUrl(ev.slug),
        registrations: await this.repos.crmEvent.countRegistrations(id),
        emails: emails.map((e: any) => ({ ...e, sends: stats[e.id] || { sent: 0, failed: 0 } })),
        zones: { registrants: await this.repos.crmEvent.registrantZones(au.churchId, id), crm: (await this.repos.crm.stats(au.churchId)).timezones }
      };
    });
  }

  @httpPost("/events/:id")
  public async save(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, true, async (au, svc) => ({ ...(await svc.update(au.churchId, id, req.body)) }));
  }

  @httpDelete("/events/:id")
  public async remove(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, true, async (au) => {
      await this.withEvent(au, id);
      await this.repos.crmEvent.remove(au.churchId, id);
      AuditLogHelper.log(this.repos, au.churchId, au.id, "crm", "event_deleted", "crmEvent", id, undefined, AuditLogHelper.getClientIp(req));
      return { ok: true };
    });
  }

  @httpPost("/events/:id/draft-page")
  public async draftPage(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, true, async (au, svc) => svc.draftPage(au.churchId, id));
  }

  @httpPost("/events/:id/flyer")
  public async flyer(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, true, async (au, svc) => svc.uploadFlyer(au.churchId, id, req.body));
  }

  @httpGet("/events/:id/registrations")
  public async registrations(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, false, async (au) => {
      await this.withEvent(au, id);
      return this.repos.crmEvent.registrations(au.churchId, id);
    });
  }

  @httpPost("/events/:id/registrations/:regId")
  public async setRegistration(@requestParam("id") id: string, @requestParam("regId") regId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, true, async (au) => {
      const status = String((req.body as any)?.status || "");
      if (!["registered", "cancelled", "attended"].includes(status)) return this.json({ error: "bad_status" }, 400);
      const reg = await this.repos.crmEvent.loadRegistration(au.churchId, regId);
      if (!reg || reg.eventId !== id) return this.json({ error: "not_found" }, 404);
      await this.repos.crmEvent.setRegistrationStatus(au.churchId, regId, status);
      return { ok: true };
    });
  }

  // ── emails ──
  @httpPost("/events/:id/emails")
  public async addEmail(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, true, async (au) => {
      await this.withEvent(au, id);
      const fields = this.emailFields(req.body);
      if (!fields.kind) return this.json({ error: "bad_kind" }, 400);
      return { id: await this.repos.crmEvent.saveEmail(au.churchId, { eventId: id, ...fields }) };
    });
  }

  @httpPost("/events/:id/emails/:emailId")
  public async saveEmail(@requestParam("id") id: string, @requestParam("emailId") emailId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, true, async (au) => {
      const email = await this.repos.crmEvent.loadEmail(au.churchId, emailId);
      if (!email || email.eventId !== id) return this.json({ error: "not_found" }, 404);
      const fields = this.emailFields(req.body);
      delete fields.kind;
      // A one-off that already went out cannot be rescheduled (it would not resend anyway).
      if (email.sentAt && (email.kind === "invite" || email.kind === "update")) delete fields.sendAt;
      await this.repos.crmEvent.saveEmail(au.churchId, fields, emailId);
      return { ok: true };
    });
  }

  @httpDelete("/events/:id/emails/:emailId")
  public async removeEmail(@requestParam("id") id: string, @requestParam("emailId") emailId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, true, async (au) => {
      const email = await this.repos.crmEvent.loadEmail(au.churchId, emailId);
      if (!email || email.eventId !== id) return this.json({ error: "not_found" }, 404);
      await this.repos.crmEvent.removeEmail(au.churchId, emailId);
      return { ok: true };
    });
  }

  /** Send one copy to the signed-in staff member (does not count as sent). */
  @httpPost("/events/:id/emails/:emailId/test")
  public async testEmail(@requestParam("id") id: string, @requestParam("emailId") emailId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, true, async (au) => {
      const ev = await this.withEvent(au, id);
      const email = await this.repos.crmEvent.loadEmail(au.churchId, emailId);
      if (!email || email.eventId !== id) return this.json({ error: "not_found" }, 404);
      const to = String((req.body as any)?.to || au.email || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return this.json({ error: "email" }, 400);
      const out = await CrmEventMailer.sendOne(this.repos, au.churchId, ev, { ...email, subject: "[Test] " + email.subject }, { key: "test", email: to, firstName: au.firstName || "Friend", timezone: (req.body as any)?.timezone || null, personId: null }, { marketing: email.kind !== "confirmation" && email.kind !== "reminder", test: true });
      return { ok: out === "sent", result: out, to };
    });
  }

  /** How many people an audience reaches (before scheduling an invite). */
  @httpPost("/events/:id/audience-count")
  public async audienceCount(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, false, async (au) => {
      const ev = await this.withEvent(au, id);
      const people = await CrmEventMailer.audience(this.repos, au.churchId, ev, req.body);
      return { count: people.length, sample: people.slice(0, 8).map((p) => p.email) };
    });
  }

  private emailFields(body: any): Record<string, any> {
    const b = body || {};
    const out: Record<string, any> = {};
    if ("kind" in b) out.kind = ["reminder", "followup", "invite", "update", "confirmation"].includes(b.kind) ? b.kind : null;
    if ("subject" in b) out.subject = String(b.subject || "").slice(0, 300) || "(no subject)";
    if ("body" in b) out.body = String(b.body || "").slice(0, 50000);
    if ("enabled" in b) out.enabled = !!b.enabled;
    if ("offsetMinutes" in b) out.offsetMinutes = b.offsetMinutes === null || b.offsetMinutes === "" ? null : Math.max(-60 * 24 * 60, Math.min(60 * 24 * 60, Math.round(Number(b.offsetMinutes)) || 0));
    if ("sendAt" in b) { const d = b.sendAt ? new Date(b.sendAt) : null; out.sendAt = d && !isNaN(d.getTime()) ? d : null; }
    if ("audience" in b) {
      const a = b.audience || {};
      out.audience = a.type === "crm"
        ? { type: "crm", countryCode: a.countryCode || null, tagId: a.tagId || null, status: a.status || null, q: a.q || null, personIds: Array.isArray(a.personIds) ? a.personIds.slice(0, 5000).map(String) : null }
        : { type: "registrants" };
    }
    return out;
  }

  // ── public ──
  /** Published events that have not ended, soonest first (for the site's Events page). */
  @httpGet("/public/events")
  public async publicList(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      const svc = new CrmEventService(this.repos);
      const churchId = await svc.churchIdOrNull();
      if (!churchId) return [];
      const now = Date.now();
      const list = (await this.repos.crmEvent.list(churchId))
        .filter((e: any) => e.status === "published" && e.startsAt && new Date(e.endsAt || e.startsAt).getTime() >= now)
        .sort((a: any, b: any) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
      return list.slice(0, 20).map((e: any) => {
        const v = svc.publicView(e, e.registrations);
        return { slug: v.slug, kindLabel: v.kindLabel, title: v.title, subtitle: v.subtitle, startsAt: v.startsAt, endsAt: v.endsAt, timezone: v.timezone, location: v.location, imageUrl: v.imageUrl, registrationOpen: v.registrationOpen };
      });
    });
  }

  @httpGet("/public/events/:slug")
  public async publicEvent(@requestParam("slug") slug: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      try {
        return await new CrmEventService(this.repos).publicEvent(slug);
      } catch (e: any) {
        if (e instanceof EventError) return this.json({ error: e.code }, e.status);
        throw e;
      }
    });
  }

  @httpPost("/public/events/:slug/register")
  public async register(@requestParam("slug") slug: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      const body: any = req.body ?? {};
      if (PublicFormSubmissionHelper.isBot(body)) return { ok: true };
      if (!PublicFormSubmissionHelper.rateLimit(AuditLogHelper.getClientIp(req), "event:" + slug)) return this.json({ error: "too_many" }, 429);
      try {
        return await new CrmEventService(this.repos).register(slug, body);
      } catch (e: any) {
        if (e instanceof EventError) return this.json({ error: e.code }, e.status);
        throw e;
      }
    });
  }
}
