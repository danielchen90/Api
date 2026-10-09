import { type Kysely, sql } from "kysely";

// Chat safety (App Store guideline 1.2): report and block on every chat surface.
//
//   messageReports  one row per report on a chat message (livestream, group, private).
//                   reporterPersonId is NULL for anonymous livestream guests; reporterIp is
//                   kept for the per-IP report limit and never sent to clients. The message
//                   text and sender are copied in at report time so staff still see what was
//                   said after the message is removed. resolvedAt NULL = open; action is
//                   "removed" or "dismissed".
//   memberBlocks    a signed-in member's block list (personId blocked blockedPersonId).
//   messages.ipHash a keyed hash of the sender's IP (never the raw IP), so staff can block an
//                   anonymous livestream sender from the stream through blockedIps.
//
// No COLLATE anywhere: tables take the server default (prod utf8mb4_0900_ai_ci). Sorts after
// 2026-07-12_campaign_campus_sentAt.ts (Kysely rejects out-of-order migrations).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("messageReports")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("messageId", sql`char(11)`, (col) => col.notNull())
    .addColumn("conversationId", sql`char(11)`)
    .addColumn("reporterPersonId", sql`char(11)`)
    .addColumn("reporterIp", sql`varchar(45)`)
    .addColumn("reason", sql`varchar(20)`, (col) => col.notNull())
    .addColumn("note", sql`varchar(1000)`)
    .addColumn("messageSnapshot", sql`text`)
    .addColumn("senderPersonId", sql`char(11)`)
    .addColumn("senderDisplayName", sql`varchar(100)`)
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("resolvedAt", sql`datetime`)
    .addColumn("resolvedBy", sql`char(11)`)
    .addColumn("action", sql`varchar(20)`)
    .modifyEnd(sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    .execute();

  await db.schema.createIndex("idx_messageReports_church_resolved").on("messageReports").columns(["churchId", "resolvedAt"]).execute();
  await db.schema.createIndex("idx_messageReports_message").on("messageReports").columns(["churchId", "messageId"]).execute();
  await db.schema.createIndex("idx_messageReports_ip_created").on("messageReports").columns(["reporterIp", "createdAt"]).execute();

  await db.schema
    .createTable("memberBlocks")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("personId", sql`char(11)`, (col) => col.notNull())
    .addColumn("blockedPersonId", sql`char(11)`, (col) => col.notNull())
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .modifyEnd(sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    .execute();

  await db.schema.createIndex("uq_memberBlocks_church_person_blocked").unique().on("memberBlocks").columns(["churchId", "personId", "blockedPersonId"]).execute();

  await db.schema.alterTable("messages").addColumn("ipHash", sql`varchar(64)`).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("messages").dropColumn("ipHash").execute();
  await db.schema.dropTable("memberBlocks").ifExists().execute();
  await db.schema.dropTable("messageReports").ifExists().execute();
}
