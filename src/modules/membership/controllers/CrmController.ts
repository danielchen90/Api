import { controller, httpDelete, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { AuthenticatedUser } from "@churchapps/apihelper";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { Permissions } from "../helpers/index.js";
import { CampusScopeHelper } from "../helpers/CampusScopeHelper.js";
import { AuditLogHelper } from "../helpers/AuditLogHelper.js";
import { CrmService, Actor } from "../helpers/crm/CrmService.js";
import { CrmAiService, CrmAiError } from "../helpers/crm/CrmAiService.js";
import { CrmSyncService } from "../helpers/crm/CrmSyncService.js";
import { CrmActivitySync } from "../helpers/crm/CrmActivitySync.js";
import { CrmConfig } from "../helpers/crm/CrmConfig.js";

/**
 * The ministry-wide CRM (/membership/crm).
 *
 * Reads need People View, writes People Edit. The CRM-wide screens (list, stats, Ask the CRM,
 * capture of a new person, sync) are for org-wide staff only (campus scope "all"), because most CRM
 * contacts belong to no campus. A campus-scoped admin can still open the CRM profile of a person on
 * one of their campuses.
 */
@controller("/membership/crm")
export class CrmController extends MembershipBaseController {
  private actor(au: AuthenticatedUser): Actor {
    return { userId: au.id, name: [au.firstName, au.lastName].filter(Boolean).join(" ") || au.email || "Staff" };
  }

  private async orgWide(au: AuthenticatedUser): Promise<boolean> {
    return (await CampusScopeHelper.resolve(au, this.repos)).mode === "all";
  }

  private async canSeePerson(au: AuthenticatedUser, personId: string): Promise<boolean> {
    const scope = await CampusScopeHelper.resolve(au, this.repos);
    if (scope.mode === "all") return true;
    if (scope.mode === "deny") return false;
    const p: any = await this.repos.person.load(au.churchId, personId);
    return !!p && !!p.campusId && scope.campusIds.includes(p.campusId);
  }

  /** Common wrapper: permission + scope checks, and CRM/AI errors as { error } JSON. */
  private run(req: express.Request, res: express.Response, opts: { edit?: boolean; orgWide?: boolean; personId?: string }, fn: (au: AuthenticatedUser) => Promise<any>) {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(opts.edit ? Permissions.people.edit : Permissions.people.view)) return this.json({ error: "forbidden" }, 401);
      if (opts.orgWide && !(await this.orgWide(au))) return this.json({ error: "org_wide_only" }, 403);
      if (opts.personId && !(await this.canSeePerson(au, opts.personId))) return this.json({ error: "not_found" }, 404);
      try {
        return await fn(au);
      } catch (e: any) {
        if (e instanceof CrmAiError) return this.json({ error: e.code }, e.status);
        if (e?.status) return this.json({ error: e.message }, e.status);
        throw e;
      }
    });
  }

  @httpGet("/stats")
  public async stats(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { orgWide: true }, async (au) => ({
      ...(await this.repos.crm.stats(au.churchId)),
      ai: CrmConfig.aiConfigured,
      sync: {
        keycloak: JSON.parse((await this.repos.crm.getState("keycloak.lastRun")) || "null"),
        activity: JSON.parse((await this.repos.crm.getState("activity.lastRun")) || "null"),
        sources: CrmActivitySync.configuredSources()
      }
    }));
  }

  @httpGet("/people")
  public async people(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { orgWide: true }, async (au) => {
      const q = req.query as any;
      return this.repos.crm.search(au.churchId, {
        q: q.q,
        status: q.status,
        source: q.source,
        countryCode: q.countryCode,
        tagId: q.tagId,
        consent: q.consent,
        limit: Number(q.limit) || 50,
        offset: Number(q.offset) || 0
      });
    });
  }

  @httpGet("/people/:id")
  public async person(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { personId: id }, async (au) => (await new CrmService(this.repos).profileView(au.churchId, id)) || this.json({ error: "not_found" }, 404));
  }

  @httpPost("/people/:id/profile")
  public async saveProfile(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { edit: true, personId: id }, async (au) => {
      const out = await new CrmService(this.repos).updateProfile(au.churchId, id, req.body, this.actor(au));
      AuditLogHelper.log(this.repos, au.churchId, au.id, "person", "crm_profile_saved", "person", id, Object.keys(req.body || {}), AuditLogHelper.getClientIp(req) as any);
      return out;
    });
  }

  @httpPost("/people/:id/notes")
  public async addNote(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { edit: true, personId: id }, async (au) => ({ id: await new CrmService(this.repos).addNote(au.churchId, id, (req.body as any)?.text, this.actor(au)) }));
  }

  @httpDelete("/notes/:noteId")
  public async deleteNote(@requestParam("noteId") noteId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { edit: true, orgWide: true }, async (au) => {
      await this.repos.crm.deleteNote(au.churchId, noteId);
      return { ok: true };
    });
  }

  @httpPost("/people/:id/facts")
  public async addFact(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { edit: true, personId: id }, async (au) => ({ id: await new CrmService(this.repos).addFact(au.churchId, id, (req.body as any)?.kind, (req.body as any)?.text) }));
  }

  @httpPost("/facts/:factId")
  public async setFact(@requestParam("factId") factId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { edit: true, orgWide: true }, async (au) => {
      await this.repos.crm.setFactStatus(au.churchId, factId, (req.body as any)?.status === "done" ? "done" : "open");
      return { ok: true };
    });
  }

  @httpDelete("/facts/:factId")
  public async deleteFact(@requestParam("factId") factId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { edit: true, orgWide: true }, async (au) => {
      await this.repos.crm.deleteFact(au.churchId, factId);
      return { ok: true };
    });
  }

  @httpGet("/tags")
  public async tags(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, {}, async (au) => this.repos.crm.loadTags(au.churchId));
  }

  @httpDelete("/tags/:tagId")
  public async deleteTag(@requestParam("tagId") tagId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { edit: true, orgWide: true }, async (au) => {
      await this.repos.crm.deleteTag(au.churchId, tagId);
      return { ok: true };
    });
  }

  @httpPost("/people/:id/tags")
  public async tagPerson(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { edit: true, personId: id }, async (au) => {
      const name = String((req.body as any)?.name || "").trim();
      if (!name) return this.json({ error: "empty" }, 400);
      const tagId = await this.repos.crm.ensureTag(au.churchId, name);
      await this.repos.crm.tagPerson(au.churchId, id, tagId);
      return this.repos.crm.loadPersonTags(au.churchId, id);
    });
  }

  @httpDelete("/people/:id/tags/:tagId")
  public async untagPerson(@requestParam("id") id: string, @requestParam("tagId") tagId: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { edit: true, personId: id }, async (au) => {
      await this.repos.crm.untagPerson(au.churchId, id, tagId);
      return this.repos.crm.loadPersonTags(au.churchId, id);
    });
  }

  @httpPost("/capture/preview")
  public async capturePreview(req: express.Request, res: express.Response): Promise<any> {
    const personId = (req.body as any)?.personId || null;
    return this.run(req, res, personId ? { edit: true, personId } : { edit: true, orgWide: true }, async (au) =>
      new CrmService(this.repos).preview(au.churchId, { text: (req.body as any)?.text, images: (req.body as any)?.images, personId }));
  }

  @httpPost("/capture/save")
  public async captureSave(req: express.Request, res: express.Response): Promise<any> {
    const personId = (req.body as any)?.personId || null;
    return this.run(req, res, personId ? { edit: true, personId } : { edit: true, orgWide: true }, async (au) => {
      const b = req.body as any;
      if (!b?.extraction?.person) return this.json({ error: "no_extraction" }, 400);
      const out = await new CrmService(this.repos).save(au.churchId, { personId, text: b.text, extraction: b.extraction, imageCount: Number(b.imageCount) || 0 }, this.actor(au));
      AuditLogHelper.log(this.repos, au.churchId, au.id, "person", out.created ? "crm_capture_created" : "crm_capture_saved", "person", out.personId!, { changes: out.changes }, AuditLogHelper.getClientIp(req) as any);
      // The summary is refreshed in the background; the screen re-reads it.
      if (CrmConfig.aiConfigured) new CrmAiService(this.repos).summarize(au.churchId, out.personId!).catch((e) => console.error("[crm] summary failed:", e?.message || e));
      return out;
    });
  }

  @httpPost("/people/:id/summary")
  public async summary(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { personId: id }, async (au) => ({ summary: await new CrmAiService(this.repos).summarize(au.churchId, id) }));
  }

  @httpPost("/ask")
  public async ask(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { orgWide: true }, async (au) => {
      const b = req.body as any;
      const history = Array.isArray(b?.history) ? b.history.filter((h: any) => (h?.role === "user" || h?.role === "assistant") && typeof h.content === "string") : [];
      return new CrmAiService(this.repos).ask(au.churchId, String(b?.question || ""), history);
    });
  }

  @httpPost("/sync/run")
  public async syncRun(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, { edit: true, orgWide: true }, async () => {
      const what = String((req.query as any).what || "all");
      const out: any = {};
      if (what === "all" || what === "keycloak") out.keycloak = await new CrmSyncService(this.repos).run();
      if (what === "all" || what === "activity") out.activity = await new CrmActivitySync(this.repos).run();
      return out;
    });
  }
}
