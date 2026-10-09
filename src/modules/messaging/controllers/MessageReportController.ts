import { controller, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";
import { ChatSafetyHelper } from "../helpers/ChatSafetyHelper.js";

// Staff review of chat reports (App Store guideline 1.2). New reports are filed through
// POST /messaging/messages/report; staff list the open ones here and either remove the
// message (deleted for everyone, like the chat delete link) or dismiss the report.
@controller("/messaging/messagereports")
export class MessageReportController extends MessagingBaseController {
  @httpGet("/")
  public async list(req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au?.churchId || !ChatSafetyHelper.isStaff(au)) return this.json({ error: "Unauthorized" }, 401);
      const open = (req.query.status as string) !== "resolved";
      const reports = await this.repos.messageReport.loadForChurch(au.churchId, open);
      const conversationIds = Array.from(new Set(reports.map((r) => r.conversationId).filter(Boolean)));
      const kinds: Record<string, string> = {};
      for (const id of conversationIds) {
        const c: any = await this.repos.conversation.loadById(au.churchId, id);
        kinds[id] = ChatSafetyHelper.conversationKind(c?.contentType);
      }
      // reporterIp stays server-side.
      return reports.map((r) => ({
        id: r.id,
        messageId: r.messageId,
        conversationId: r.conversationId,
        kind: kinds[r.conversationId] || "Chat",
        reason: r.reason,
        note: r.note,
        messageSnapshot: r.messageSnapshot,
        senderPersonId: r.senderPersonId,
        senderDisplayName: r.senderDisplayName,
        reporterPersonId: r.reporterPersonId,
        anonymousReporter: !r.reporterPersonId,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
        resolvedBy: r.resolvedBy,
        action: r.action
      }));
    });
  }

  /** body.action: "remove" (delete the message, close every open report on it) or "dismiss". */
  @httpPost("/:id/resolve")
  public async resolve(@requestParam("id") id: string, req: express.Request<{}, {}, { action?: string }>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au?.churchId || !ChatSafetyHelper.isStaff(au)) return this.json({ error: "Unauthorized" }, 401);
      const report = await this.repos.messageReport.loadById(au.churchId, id);
      if (!report) return this.json({ error: "Report not found" }, 404);
      const action = req.body?.action === "remove" ? "removed" : req.body?.action === "dismiss" ? "dismissed" : null;
      if (!action) return this.json({ error: "invalid_action" }, 400);
      const by = au.personId || au.id;
      if (action === "removed") {
        await ChatSafetyHelper.removeMessage(this.repos, au.churchId, report.messageId);
        await this.repos.messageReport.resolveForMessage(au.churchId, report.messageId, by, action);
      } else {
        await this.repos.messageReport.resolve(au.churchId, id, by, action);
      }
      return { id, action };
    });
  }
}
