import { sql } from "kysely";
import { injectable } from "inversify";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { getDb } from "../db/index.js";
import { MessageReport } from "../models/index.js";

// Chat reports (App Store guideline 1.2): a member or a livestream guest flags a message;
// staff review the open ones and remove the message or dismiss the report.
@injectable()
export class MessageReportRepo {
  public async create(model: MessageReport): Promise<MessageReport> {
    model.id = UniqueIdHelper.shortId();
    model.createdAt = new Date();
    await getDb().insertInto("messageReports").values({
      id: model.id,
      churchId: model.churchId,
      messageId: model.messageId,
      conversationId: model.conversationId,
      reporterPersonId: model.reporterPersonId || null,
      reporterIp: model.reporterIp || null,
      reason: model.reason,
      note: model.note || null,
      messageSnapshot: model.messageSnapshot || null,
      senderPersonId: model.senderPersonId || null,
      senderDisplayName: model.senderDisplayName || null,
      createdAt: model.createdAt
    }).execute();
    return model;
  }

  public async loadById(churchId: string, id: string): Promise<MessageReport | null> {
    return (await getDb().selectFrom("messageReports").selectAll()
      .where("churchId", "=", churchId).where("id", "=", id).executeTakeFirst()) ?? null;
  }

  /** Open reports (newest first), or the most recent resolved ones when open=false. */
  public async loadForChurch(churchId: string, open: boolean, limit = 200): Promise<MessageReport[]> {
    let q = getDb().selectFrom("messageReports").selectAll().where("churchId", "=", churchId);
    q = open ? q.where("resolvedAt", "is", null) : q.where("resolvedAt", "is not", null);
    return q.orderBy("createdAt", "desc").limit(limit).execute();
  }

  /** An open report on this message from the same reporter (person, else IP): reporting twice does not add a row. */
  public async findOpenDuplicate(churchId: string, messageId: string, reporterPersonId: string | null, reporterIp: string | null) {
    let q = getDb().selectFrom("messageReports").select("id")
      .where("churchId", "=", churchId).where("messageId", "=", messageId).where("resolvedAt", "is", null);
    if (reporterPersonId) q = q.where("reporterPersonId", "=", reporterPersonId);
    else q = q.where("reporterIp", "=", reporterIp || "");
    return (await q.executeTakeFirst()) ?? null;
  }

  /** How many reports this IP filed in the last hour (simple per-IP brake for anonymous reports). */
  public async countRecentByIp(reporterIp: string, minutes = 60): Promise<number> {
    const row = await getDb().selectFrom("messageReports")
      .select(sql<number>`count(*)`.as("cnt"))
      .where("reporterIp", "=", reporterIp)
      .where("createdAt", ">", sql<Date>`DATE_SUB(NOW(), INTERVAL ${minutes} MINUTE)`)
      .executeTakeFirst();
    return Number((row as any)?.cnt || 0);
  }

  /** Close every open report on a message (removing the message settles all of them). */
  public async resolveForMessage(churchId: string, messageId: string, resolvedBy: string, action: string) {
    await getDb().updateTable("messageReports")
      .set({ resolvedAt: new Date(), resolvedBy, action })
      .where("churchId", "=", churchId).where("messageId", "=", messageId).where("resolvedAt", "is", null)
      .execute();
  }

  public async resolve(churchId: string, id: string, resolvedBy: string, action: string) {
    await getDb().updateTable("messageReports")
      .set({ resolvedAt: new Date(), resolvedBy, action })
      .where("churchId", "=", churchId).where("id", "=", id)
      .execute();
  }
}
