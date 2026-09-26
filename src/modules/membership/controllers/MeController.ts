import { controller, httpDelete, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import { AuditLogHelper } from "../helpers/AuditLogHelper.js";
import { MemberError, MemberAccountService } from "../helpers/mbid/MemberAccountService.js";
import { buildMemberAccountService } from "../helpers/mbid/MemberServiceFactory.js";

/**
 * My Church: the signed-in member's own view of the church record (GET/POST under /membership/me).
 *
 * Auth: the normal ChurchApps member JWT. Every handler requires a user id AND a church id in the
 * token (401 otherwise) and only ever reads or writes the caller's OWN data; the linked person is
 * always re-read from userChurches (never trusted from the token, which may predate a claim).
 * Every response is a whitelisted DTO built in MemberAccountService.
 *
 * Errors answer { error: code } (plus { errors: [...] } for field validation), codes the public
 * site already understands: already_yours, other_account, wrong_code, expired, too_many.
 */
@controller("/membership/me")
export class MeController extends MembershipBaseController {
  private static signedIn(au: any): boolean {
    return !!au?.id && !!au?.churchId;
  }

  private async run(req: express.Request, res: express.Response, fn: (svc: MemberAccountService, au: any) => Promise<any>) {
    return this.actionWrapper(req, res, async (au) => {
      if (!MeController.signedIn(au)) return this.json({ error: "unauthorized" }, 401);
      try {
        const svc = buildMemberAccountService(this.repos, AuditLogHelper.getClientIp(req));
        return await fn(svc, au);
      } catch (e: any) {
        if (e instanceof MemberError) {
          const body: any = { error: e.code };
          if (Array.isArray((e as any).errors)) body.errors = (e as any).errors;
          return this.json(body, e.status);
        }
        throw e;
      }
    });
  }

  @httpGet("/overview")
  public async overview(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, (svc, au) => svc.overview(au.id, au.churchId));
  }

  @httpPost("/person")
  public async person(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, (svc, au) => svc.updatePerson(au.id, au.churchId, req.body));
  }

  @httpPost("/claim")
  public async claim(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, (svc, au) => svc.claim(au.id, au.churchId, (req.body as any)?.personId, AuditLogHelper.getClientIp(req)));
  }

  @httpPost("/emails/start")
  public async emailsStart(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, (svc, au) => svc.startEmail(au.id, (req.body as any)?.email));
  }

  @httpPost("/emails/verify")
  public async emailsVerify(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, (svc, au) => svc.verifyEmail(au.id, au.churchId, (req.body as any)?.email, (req.body as any)?.code));
  }

  @httpDelete("/emails/:email")
  public async emailsRemove(@requestParam("email") email: string, req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, (svc, au) => svc.removeEmail(au.id, au.churchId, email));
  }

  @httpGet("/submissions")
  public async submissions(req: express.Request, res: express.Response): Promise<any> {
    return this.run(req, res, (svc, au) => svc.submissions(au.id, au.churchId));
  }
}
