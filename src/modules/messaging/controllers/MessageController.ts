import { controller, httpGet, httpPost, httpDelete, requestParam } from "inversify-express-utils";
import express from "express";
import { MessagingBaseController } from "./MessagingBaseController.js";
import { Message } from "../models/index.js";
import { DeliveryHelper } from "../helpers/DeliveryHelper.js";
import { NotificationHelper } from "../helpers/NotificationHelper.js";
import { Permissions } from "../../../shared/helpers/Permissions.js";
import { ChatContentFilter } from "../helpers/ChatContentFilter.js";
import { ChatSafetyHelper } from "../helpers/ChatSafetyHelper.js";

const contentRoom = (contentType?: string, contentId?: string) =>
  contentType && contentId ? `content-${contentType}-${contentId}` : null;

@controller("/messaging/messages")
export class MessageController extends MessagingBaseController {
  @httpGet("/conversation/:conversationId")
  public async loadByConversation(@requestParam("conversationId") conversationId: string, req: express.Request<{}, {}, []>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const messages: Message[] = await this.repos.message.loadForConversation(au.churchId, conversationId);
      // Hide messages from people this member has blocked.
      const blocked = new Set(await this.repos.memberBlock.loadBlockedIds(au.churchId, au.personId));
      return this.repos.message.convertAllToModel(messages).filter((m: Message) => !m.personId || !blocked.has(m.personId));
    });
  }

  @httpGet("/catchup/:churchId/:conversationId")
  public async catchup(@requestParam("churchId") churchId: string, @requestParam("conversationId") conversationId: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<Message[]> {
    return this.actionWrapperAnon(req, res, async () => {
      const messages: Message[] = await this.repos.message.loadForConversation(churchId, conversationId);
      return this.repos.message.convertAllToModel(messages);
    }) as any;
  }

  @httpPost("/send")
  public async send(req: express.Request<{}, {}, Message[]>, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      // Chat safety: guests may post without signing in, so the server rejects slurs and
      // explicit words, and senders a host blocked from this stream (by IP hash).
      const ip = ChatSafetyHelper.clientIp(req);
      const ipHash = ChatSafetyHelper.ipHash(ip);
      for (const message of req.body || []) {
        if (ChatContentFilter.isAbusive(message?.content) || ChatContentFilter.isAbusive(message?.displayName)) {
          return this.json({ error: "message_rejected", reason: "content" }, 400);
        }
        if (message?.churchId && message?.conversationId) {
          const blocked: string[] = await this.repos.blockedIp.loadByConversationId(message.churchId, message.conversationId);
          if (blocked.length > 0 && (blocked.includes(ip) || (ipHash && blocked.includes(ipHash)))) {
            return this.json({ error: "blocked" }, 403);
          }
        }
      }
      const promises: Promise<Message>[] = [];
      req.body.forEach((message) => {
        promises.push(
          this.repos.message.save(message).then(async (savedMessage) => {
            await this.repos.message.setIpHash(savedMessage.churchId, savedMessage.id, ipHash);
            if (ipHash) savedMessage.senderKey = ipHash;
            console.info("[chat-push] message saved", {
              route: "/messaging/messages/send",
              churchId: savedMessage.churchId,
              conversationId: savedMessage.conversationId,
              messageId: savedMessage.id,
              senderPersonId: savedMessage.personId || null,
              messageType: savedMessage.messageType || "comment"
            });
            if (!savedMessage.personId) {
              console.warn("[chat-push] anonymous send route saved message without personId", {
                route: "/messaging/messages/send",
                churchId: savedMessage.churchId,
                conversationId: savedMessage.conversationId,
                messageId: savedMessage.id
              });
            }
            // Load conversation and update stats in parallel - updateStats doesn't
            // depend on the result of loadById.
            const [conversation] = await Promise.all([
              this.repos.conversation.loadById(message.churchId, message.conversationId),
              this.repos.conversation.updateStats(message.conversationId)
            ]);
            const conv = this.repos.conversation.convertToModel(conversation);

            // Fan out real-time delivery and notification escalation concurrently -
            // both are independent side-effects that each make their own AWS/DB calls.
            const room = contentRoom(conv?.contentType, conv?.contentId);
            await Promise.all([
              DeliveryHelper.sendConversationMessages({
                churchId: message.churchId,
                conversationId: message.conversationId,
                action: "message",
                data: savedMessage
              }),
              room ? DeliveryHelper.sendConversationMessages({
                churchId: message.churchId,
                conversationId: room,
                action: "conversationActivity",
                data: { contentType: conv.contentType, contentId: conv.contentId, conversationId: conv.id, kind: "message" }
              }) : Promise.resolve(),
              NotificationHelper.checkShouldNotify(conv, savedMessage, savedMessage.personId || "anonymous")
            ]);

            return savedMessage;
          })
        );
      }) as any;
      const result = await Promise.all(promises);
      return this.repos.message.convertAllToModel(result as any[]);
    }) as any;
  }

  /**
   * Report a message (App Store guideline 1.2). Open to guests because livestream chat is
   * anonymous; one IP may file MAX_REPORTS_PER_HOUR reports an hour. The message text is
   * copied from the database (not the client) so staff see what was actually posted.
   */
  @httpPost("/report")
  public async report(req: express.Request<{}, {}, { churchId?: string; messageId?: string; reason?: string; note?: string }>, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      const au = this.authUser();
      const body = req.body || {};
      const churchId = body.churchId || au?.churchId;
      const reason = ChatSafetyHelper.REPORT_REASONS.includes(body.reason) ? body.reason : null;
      if (!churchId || !body.messageId || !reason) return this.json({ error: "invalid_report" }, 400);
      const note = (body.note || "").toString().trim().substring(0, 1000) || null;
      const ip = ChatSafetyHelper.clientIp(req);
      if ((await this.repos.messageReport.countRecentByIp(ip)) >= ChatSafetyHelper.MAX_REPORTS_PER_HOUR) {
        return this.json({ error: "too_many" }, 429);
      }
      const message = await this.repos.message.loadById(churchId, body.messageId);
      if (!message?.id) return this.json({ error: "Message not found" }, 404);
      const reporterPersonId = au?.personId || null;
      if (reporterPersonId && message.personId === reporterPersonId) return this.json({ error: "own_message" }, 400);

      const duplicate = await this.repos.messageReport.findOpenDuplicate(churchId, message.id, reporterPersonId, ip);
      if (duplicate) return { id: duplicate.id, duplicate: true };

      const report = await this.repos.messageReport.create({
        churchId,
        messageId: message.id,
        conversationId: message.conversationId,
        reporterPersonId,
        reporterIp: ip,
        reason,
        note,
        messageSnapshot: (message.content || "").substring(0, 4000),
        senderPersonId: message.personId || null,
        senderDisplayName: message.displayName || null
      });
      const conversation = await this.repos.conversation.loadById(churchId, message.conversationId);
      await ChatSafetyHelper.notifyStaff(report, ChatSafetyHelper.conversationKind((conversation as any)?.contentType));
      return { id: report.id };
    }) as any;
  }

  /**
   * Staff: block the sender of a livestream message from this stream. Livestream guests are
   * anonymous, so the block is on the sender's IP hash (stored when they posted) through the
   * existing blockedIps table; /send then refuses that sender in this conversation. Cleared
   * with the service like every other blocked IP (StreamingServiceController -> /blockedIps/clear).
   */
  @httpPost("/blockSender")
  public async blockSender(req: express.Request<{}, {}, { messageId?: string; serviceId?: string }>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au?.churchId || !ChatSafetyHelper.isStaff(au)) return this.json({ error: "Unauthorized" }, 401);
      const message = await this.repos.message.loadById(au.churchId, req.body?.messageId);
      if (!message?.id) return this.json({ error: "Message not found" }, 404);
      if (!message.ipHash) return this.json({ error: "no_sender_key" }, 409);
      const existing: string[] = await this.repos.blockedIp.loadByConversationId(au.churchId, message.conversationId);
      if (!existing.includes(message.ipHash)) {
        await this.repos.blockedIp.save({ churchId: au.churchId, conversationId: message.conversationId, serviceId: req.body?.serviceId || null, ipAddress: message.ipHash });
      }
      await DeliveryHelper.sendBlockedIps(au.churchId, message.conversationId);
      return { blocked: true, senderKey: message.ipHash };
    }) as any;
  }

  @httpPost("/setCallout")
  public async setCallout(req: express.Request<{}, {}, Message>, res: express.Response): Promise<Message> {
    return this.actionWrapper(req, res, async (au) => {
      const message = req.body;
      if (!message.churchId && au?.churchId) message.churchId = au.churchId;

      // Send real-time callout update
      await DeliveryHelper.sendConversationMessages({
        churchId: message.churchId,
        conversationId: message.conversationId,
        action: "callout",
        data: message
      });

      return message;
    }) as any;
  }

  @httpGet("/:churchId/:id")
  public async loadById(@requestParam("churchId") churchId: string, @requestParam("id") id: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<Message> {
    return this.actionWrapperAnon(req, res, async () => {
      const data = await this.repos.message.loadById(churchId, id);
      return this.repos.message.convertToModel(data);
    }) as any;
  }

  @httpPost("/")
  public async save(req: express.Request<{}, {}, Message[]>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // A member who blocked this person no longer receives their private messages.
      for (const message of req.body || []) {
        const churchId = message?.churchId || au?.churchId;
        if (!churchId || !message?.conversationId || !au?.personId) continue;
        const pm = await this.repos.privateMessage.loadByConversationId(churchId, message.conversationId);
        if (!pm) continue;
        const other = pm.fromPersonId === au.personId ? pm.toPersonId : pm.fromPersonId;
        if (other && await this.repos.memberBlock.hasBlocked(churchId, other, au.personId)) {
          return this.json({ error: "blocked" }, 403);
        }
      }
      const promises: Promise<Message>[] = [];
      req.body.forEach((message) => {
        if (!message.churchId && au?.churchId) message.churchId = au.churchId;
        if (!message.personId && au?.personId) message.personId = au.personId;
        if (!message.displayName && au?.firstName) message.displayName = au.firstName + " " + au.lastName;
        promises.push(
          this.repos.message.save(message).then(async (savedMessage) => {
            console.info("[chat-push] message saved", {
              route: "/messaging/messages",
              churchId: savedMessage.churchId,
              conversationId: savedMessage.conversationId,
              messageId: savedMessage.id,
              senderPersonId: savedMessage.personId || null,
              authPersonId: au.personId || null,
              messageType: savedMessage.messageType || "comment"
            });
            // Load conversation and update stats in parallel - updateStats doesn't
            // depend on the result of loadById.
            const [conversation] = await Promise.all([
              this.repos.conversation.loadById(message.churchId, message.conversationId),
              this.repos.conversation.updateStats(message.conversationId)
            ]);
            const conv = this.repos.conversation.convertToModel(conversation);

            // Fan out real-time delivery and notification escalation concurrently -
            // both are independent side-effects that each make their own AWS/DB calls.
            const room = contentRoom(conv?.contentType, conv?.contentId);
            await Promise.all([
              DeliveryHelper.sendConversationMessages({
                churchId: message.churchId,
                conversationId: message.conversationId,
                action: "message",
                data: savedMessage
              }),
              room ? DeliveryHelper.sendConversationMessages({
                churchId: message.churchId,
                conversationId: room,
                action: "conversationActivity",
                data: { contentType: conv.contentType, contentId: conv.contentId, conversationId: conv.id, kind: "message" }
              }) : Promise.resolve(),
              NotificationHelper.checkShouldNotify(conv, savedMessage, savedMessage.personId || "anonymous")
            ]);

            return savedMessage;
          })
        );
      }) as any;
      const result = await Promise.all(promises);
      return this.repos.message.convertAllToModel(result as any[]);
    }) as any;
  }

  @httpDelete("/:id")
  public async delete(@requestParam("id") id: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<void> {
    return this.actionWrapper(req, res, async (au) => {
      const message = await this.repos.message.loadById(au.churchId, id);
      if (Object.keys(message).length === 0) {
        return this.json({ error: "Message not found" }, 404);
      }
      const isOwner = message.personId === au.personId;
      const canEdit = au.checkAccess(Permissions.content.edit);
      if (!isOwner && !canEdit) {
        return this.json({ error: "Unauthorized" }, 401);
      }
      await this.repos.message.delete(au.churchId, id);

      // Send real-time delete notification
      (await DeliveryHelper.sendConversationMessages({
        churchId: au.churchId,
        conversationId: message.conversationId,
        action: "deleteMessage",
        data: { id }
      })) as any;

      return this.json({ message: "Message deleted successfully" }, 200);
    }) as any;
  }
}
