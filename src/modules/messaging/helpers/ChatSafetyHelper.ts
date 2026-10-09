import crypto from "crypto";
import express from "express";
import { Environment } from "../../../shared/helpers/Environment.js";
import { PublicReadLimiter } from "../../../shared/helpers/PublicReadLimiter.js";
import { TransactionalEmailSender } from "../../../shared/helpers/TransactionalEmailSender.js";
import { Permissions } from "../../../shared/helpers/Permissions.js";
import { MessageReport } from "../models/index.js";
import { DeliveryHelper } from "./DeliveryHelper.js";

// Chat safety (App Store guideline 1.2): report, block, and the anonymous-sender key.
export class ChatSafetyHelper {
  public static REPORT_REASONS = ["offensive", "harassment", "spam", "other"];
  /** Reports one IP may file per hour before the endpoint answers 429. */
  public static MAX_REPORTS_PER_HOUR = 20;

  public static clientIp(req: express.Request): string {
    return PublicReadLimiter.clientIp(req);
  }

  /**
   * A keyed hash of an IP address: stable for one sender, not reversible, safe to send to
   * clients. Livestream guests are anonymous, so this is what "Block from this stream" and the
   * on-device block hold on to. 32 chars, so it also fits blockedIps.ipAddress (varchar 45).
   */
  public static ipHash(ip: string): string | null {
    if (!ip || ip === "unknown") return null;
    const secret = Environment.jwtSecret || Environment.encryptionKey || "chat-safety";
    return "h" + crypto.createHmac("sha256", secret).update(ip).digest("hex").substring(0, 31);
  }

  public static isStaff(au: any): boolean {
    if (!au?.checkAccess) return false;
    return !!(au.checkAccess(Permissions.content.edit)
      || au.checkAccess(Permissions.chat.host)
      || au.checkAccess(Permissions.streamingServices.edit));
  }

  /** Where a conversation lives, in words staff understand. */
  public static conversationKind(contentType?: string): string {
    if (contentType === "privateMessage") return "Private message";
    if (contentType === "group" || contentType === "groupAnnouncement") return "Group chat";
    if (!contentType || contentType === "streamingLive") return "Livestream chat";
    return contentType;
  }

  /** Remove a message the same way MessageController.delete does: delete, then tell the room. */
  public static async removeMessage(repos: any, churchId: string, messageId: string): Promise<boolean> {
    const message = await repos.message.loadById(churchId, messageId);
    if (!message?.id) return false;
    await repos.message.delete(churchId, messageId);
    await DeliveryHelper.sendConversationMessages({
      churchId,
      conversationId: message.conversationId,
      action: "deleteMessage",
      data: { id: messageId }
    });
    return true;
  }

  private static escape(s: string) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /**
   * Email staff about a new report. Goes to CHAT_REPORTS_EMAIL (comma-separated) or, when that
   * is unset, the Api's support address. Never throws: a report is saved even if mail fails.
   */
  public static async notifyStaff(report: MessageReport, kind: string) {
    try {
      const list = (process.env.CHAT_REPORTS_EMAIL || Environment.supportEmail || "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length === 0 || !Environment.supportEmail) return;
      const reviewUrl = (Environment.b1AdminRoot || "").replace(/\/$/, "") + "/sermons/times?tab=reports";
      const contents = "<h2>A chat message was reported</h2>"
        + "<p style='text-align:left'><b>Where:</b> " + ChatSafetyHelper.escape(kind) + "<br/>"
        + "<b>Reason:</b> " + ChatSafetyHelper.escape(report.reason) + "<br/>"
        + (report.note ? "<b>Note:</b> " + ChatSafetyHelper.escape(report.note) + "<br/>" : "")
        + "<b>Sent by:</b> " + ChatSafetyHelper.escape(report.senderDisplayName || "Unknown") + "<br/>"
        + "<b>Message:</b> " + ChatSafetyHelper.escape((report.messageSnapshot || "").substring(0, 500)) + "</p>"
        + "<p>Please review it within 24 hours: remove the message or dismiss the report.</p>"
        + "<p><a class='btn btn-primary' href='" + reviewUrl + "'>Review chat reports</a></p>";
      for (const to of list) {
        await TransactionalEmailSender.sendTemplatedEmail(Environment.supportEmail, to, Environment.appName || "Huro", Environment.b1AdminRoot, "Chat report: " + report.reason, contents);
      }
    } catch (e) {
      console.warn("[chat-safety] report email failed", (e as any)?.message || e);
    }
  }
}
