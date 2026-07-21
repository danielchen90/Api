import { controller, httpPost, httpGet, httpDelete, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { Domain } from "../models/index.js";
import { CaddyHelper, Permissions } from "../helpers/index.js";
import { DomainHealthHelper } from "../helpers/DomainHealthHelper.js";

@controller("/membership/domains")
export class DomainController extends MembershipBaseController {
  @httpGet("/caddy")
  public async caddy(req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      const jsonData = await CaddyHelper.generateJsonData();
      await CaddyHelper.updateCaddy();
      return jsonData;
    });
  }

  @httpGet("/test")
  public async test(req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      const jsonData = await CaddyHelper.generateJsonData();
      return jsonData;
    });
  }

  @httpGet("/caddy/init")
  public async caddyInit(req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      return await CaddyHelper.initializeCaddy();
    });
  }

  @httpGet("/lookup/:domainName")
  public async getByName(@requestParam("domainName") domainName: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (_au) => {
      return await this.repos.domain.loadByName(domainName);
    });
  }

  // Anonymous domain-routing lookup consumed by the B1App custom-domain
  // middleware. Returns the owning church's subDomain (the ConfigHelper key)
  // alongside churchId so the middleware needs a single fetch. www handling:
  // a leading "www." is stripped HERE so "www.bibleteachers.com" and the apex
  // "bibleteachers.com" resolve to the same church (domains are stored apex-only
  // — see DomainRepo.loadPairs which excludes "%www.%"). This is org-published
  // routing data (no member PII); it is anon-safe, and the repo returns a
  // purpose-built object, never a raw JOIN row.
  @httpGet("/public/lookup/:domainName")
  public async getPublicByName(@requestParam("domainName") domainName: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      const apex = (domainName || "").replace(/^www\./i, "");
      return await this.repos.domain.loadByNameWithSubDomain(apex);
    });
  }

  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const data = await this.repos.domain.load(au.churchId, id);
      return this.repos.domain.convertToModel(au.churchId, data);
    });
  }

  @httpGet("/")
  public async getAll(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const data = await this.repos.domain.loadAll(au.churchId);
      return this.repos.domain.convertAllToModel(au.churchId, data);
    });
  }

  @httpPost("/")
  public async save(req: express.Request<{}, {}, Domain[]>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.settings.edit)) return this.json({}, 401);
      else {
        const promises: Promise<Domain>[] = [];
        req.body.forEach((domain) => {
          domain.churchId = au.churchId;
          promises.push(this.repos.domain.save(domain));
        });
        const result = await Promise.all(promises);
        // Auto-push the Caddy route as part of save (one-step attach). If the
        // push fails, the domain record is already persisted — flag it not-live
        // (isStale) so it stays editable/retryable, and fail loudly with a
        // structured error the frontend can surface. Do NOT report success.
        try {
          await CaddyHelper.updateCaddy();
          return result;
        } catch (err: any) {
          const notLive: Promise<Domain>[] = [];
          result.forEach((domain) => {
            domain.isStale = true;
            domain.lastChecked = new Date();
            notLive.push(this.repos.domain.save(domain));
          });
          const savedNotLive = await Promise.all(notLive);
          return this.json({
            error: "Caddy route push failed",
            message: err?.message || "Domain saved but the route could not be published.",
            pushFailed: true,
            savedNotLive: true,
            domains: savedNotLive
          }, 502);
        }
      }
    });
  }

  @httpDelete("/:id")
  public async delete(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.settings.edit)) return this.json({}, 401);
      await this.repos.domain.delete(au.churchId, id);
      return {};
    });
  }

  @httpGet("/health/check")
  public async runHealthCheck(req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      return await DomainHealthHelper.checkUncheckedDomains();
    });
  }
}
