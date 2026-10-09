import { controller, httpDelete, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";

// A signed-in member's block list (App Store guideline 1.2). Blocking hides that person's
// messages from the member in group chat and private messages and stops their private
// messages reaching the member. Nobody is told they were blocked.
@controller("/messaging/memberblocks")
export class MemberBlockController extends MessagingBaseController {
  @httpGet("/")
  public async mine(req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au?.churchId || !au?.personId) return this.json({ error: "Unauthorized" }, 401);
      return { blockedPersonIds: await this.repos.memberBlock.loadBlockedIds(au.churchId, au.personId) };
    });
  }

  @httpPost("/")
  public async block(req: express.Request<{}, {}, { blockedPersonId?: string }>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au?.churchId || !au?.personId) return this.json({ error: "Unauthorized" }, 401);
      const blockedPersonId = (req.body?.blockedPersonId || "").toString().trim();
      if (!blockedPersonId || blockedPersonId.length > 11 || blockedPersonId === au.personId) return this.json({ error: "invalid_person" }, 400);
      await this.repos.memberBlock.block(au.churchId, au.personId, blockedPersonId);
      return { blockedPersonIds: await this.repos.memberBlock.loadBlockedIds(au.churchId, au.personId) };
    });
  }

  @httpDelete("/:blockedPersonId")
  public async unblock(@requestParam("blockedPersonId") blockedPersonId: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au?.churchId || !au?.personId) return this.json({ error: "Unauthorized" }, 401);
      await this.repos.memberBlock.unblock(au.churchId, au.personId, blockedPersonId);
      return { blockedPersonIds: await this.repos.memberBlock.loadBlockedIds(au.churchId, au.personId) };
    });
  }
}
