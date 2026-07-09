import { type Kysely, sql } from "kysely";

// v2.0 Communications & Email — the entire schema foundation (Phase 9). Four
// net-new churchId-scoped tables in the `messaging` database + a nullable,
// back-compatible `blockJson` column on the existing `emailTemplates`. One up(),
// one down(). No behavioral code — every later v2.0 phase (10–16) builds on
// these settled tables, so the schema lands in isolation (nothing migrates under
// a running system).
//
//   emailCampaigns      — the campaign entity. Carries the OCC `version` guard,
//                         the lifecycle `status` (draft/scheduled/sending/sent/
//                         failed/canceled — a varchar convention, NOT a MySQL
//                         ENUM, so the set evolves without ALTERs), the audience
//                         filter provenance (`audienceFilterJson`), the block
//                         builder document (`blockJson`), the rendered snapshot
//                         (`renderedHtml`/`renderedText`, inline mediumtext — the
//                         send pipeline reads these directly, no FileStorage ref),
//                         and DB-backed rollup counters (recipientCount/sentCount/
//                         failedCount) so partial-failure is expressed as counters,
//                         never a status.
//
//   campaignRecipients  — one frozen row per resolved recipient. `email`/`campusId`
//                         are FROZEN at resolve time (audience snapshot), `status`
//                         drives the send drain, and the open/click/bounce/unsub
//                         stamps + providerMessageId feed tracking (Phase 13).
//
//   campaignEvents      — append-only provider webhook events. `providerEventId`
//                         is UNIQUE for idempotent webhook processing (a redelivered
//                         Resend/Svix event collides and is dropped).
//
//   emailSuppression    — church-wide suppression list. UNIQUE (churchId, email)
//                         — a plain full unique (there is no active-subset here, so
//                         NO generated-column partial-unique trick). `reason` +
//                         `sourceCampaignId` + `createdAt` carry provenance.
//
// Conventions mirror 2026-06-30_ordinations.ts / 2026-07-08_printBatches.ts
// verbatim: char(11) ids, named indexes, bit(1) `removed` soft delete, status as
// varchar(20). EVERY table ends ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 — all four
// carry subject/HTML/name/email user-text (RESEARCH Pitfall 6). JSON columns are
// text/longtext (NO native MySQL json). The date prefix sorts strictly after the
// last-applied messaging migration 2026-05-23_fix_webpush_token_storage.ts —
// Kysely rejects out-of-order migrations (project memory / RESEARCH Pitfall 3).
export async function up(db: Kysely<any>): Promise<void> {
  // ---- emailCampaigns: the campaign entity (OCC + lifecycle + rollups) ----
  await db.schema
    .createTable("emailCampaigns")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    // status set: draft/scheduled/sending/sent/failed/canceled (LOCKED — NO
    // partially_sent, NO paused; partial failure is counters not a status).
    .addColumn("status", sql`varchar(20)`, (col) => col.notNull().defaultTo("draft"))
    .addColumn("version", sql`int`, (col) => col.notNull().defaultTo(1))
    .addColumn("name", sql`varchar(255)`)
    .addColumn("scheduledAt", sql`datetime`)
    .addColumn("audienceFilterJson", sql`text`)
    .addColumn("templateId", sql`char(11)`)
    .addColumn("blockJson", sql`longtext`)
    .addColumn("subject", sql`varchar(500)`)
    .addColumn("renderedHtml", sql`mediumtext`)
    .addColumn("renderedText", sql`mediumtext`)
    .addColumn("recipientCount", sql`int`, (col) => col.notNull().defaultTo(0))
    .addColumn("sentCount", sql`int`, (col) => col.notNull().defaultTo(0))
    .addColumn("failedCount", sql`int`, (col) => col.notNull().defaultTo(0))
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("createdBy", sql`char(11)`)
    .addColumn("updatedAt", sql`datetime`)
    .addColumn("removed", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .modifyEnd(sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    .execute();

  // ---- campaignRecipients: frozen per-recipient send + tracking row ----
  await db.schema
    .createTable("campaignRecipients")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("campaignId", sql`char(11)`, (col) => col.notNull())
    .addColumn("personId", sql`char(11)`)
    // email + campusId are FROZEN at resolve time (audience snapshot).
    .addColumn("email", sql`varchar(255)`)
    .addColumn("campusId", sql`char(11)`)
    .addColumn("mergeSnapshot", sql`text`)
    .addColumn("status", sql`varchar(20)`, (col) => col.notNull().defaultTo("pending"))
    .addColumn("openedAt", sql`datetime`)
    .addColumn("clickedAt", sql`datetime`)
    .addColumn("bouncedAt", sql`datetime`)
    .addColumn("unsubscribedAt", sql`datetime`)
    .addColumn("providerMessageId", sql`varchar(255)`)
    .addColumn("errorMessage", sql`varchar(500)`)
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .modifyEnd(sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    .execute();

  // ---- campaignEvents: append-only provider webhook events ----
  await db.schema
    .createTable("campaignEvents")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("campaignId", sql`char(11)`)
    .addColumn("recipientId", sql`char(11)`)
    .addColumn("eventType", sql`varchar(50)`)
    .addColumn("payloadJson", sql`text`)
    .addColumn("providerEventId", sql`varchar(255)`)
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .modifyEnd(sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    .execute();

  // ---- emailSuppression: church-wide suppression list ----
  await db.schema
    .createTable("emailSuppression")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("email", sql`varchar(255)`, (col) => col.notNull())
    .addColumn("reason", sql`varchar(20)`, (col) => col.notNull())
    .addColumn("sourceCampaignId", sql`char(11)`)
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .modifyEnd(sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    .execute();

  // ── Indexes ──────────────────────────────────────────────────────────────

  // emailCampaigns: scheduler drain (REQUIRED) + list.
  await db.schema
    .createIndex("idx_emailCampaigns_church_status_scheduled")
    .on("emailCampaigns")
    .columns(["churchId", "status", "scheduledAt"])
    .execute();
  await db.schema
    .createIndex("idx_emailCampaigns_church_created")
    .on("emailCampaigns")
    .columns(["churchId", "createdAt"])
    .execute();

  // campaignRecipients: send drain (REQUIRED) + webhook tenancy lookup.
  await db.schema
    .createIndex("idx_campaignRecipients_church_campaign_status")
    .on("campaignRecipients")
    .columns(["churchId", "campaignId", "status"])
    .execute();
  await db.schema
    .createIndex("idx_campaignRecipients_church_providerMsg")
    .on("campaignRecipients")
    .columns(["churchId", "providerMessageId"])
    .execute();

  // campaignEvents: idempotent webhook (REQUIRED UNIQUE on providerEventId) + list.
  await db.schema
    .createIndex("uq_campaignEvents_providerEventId")
    .unique()
    .on("campaignEvents")
    .columns(["providerEventId"])
    .execute();
  await db.schema
    .createIndex("idx_campaignEvents_church_campaign")
    .on("campaignEvents")
    .columns(["churchId", "campaignId"])
    .execute();

  // emailSuppression: church-wide dedupe (REQUIRED UNIQUE — plain full unique,
  // NO generated-column trick; there is no active-subset here).
  await db.schema
    .createIndex("uq_emailSuppression_church_email")
    .unique()
    .on("emailSuppression")
    .columns(["churchId", "email"])
    .execute();

  // ── ALTER emailTemplates: nullable back-compatible blockJson ───────────────
  // Nullable by omission — existing HTML-only template rows keep blockJson NULL
  // (no data loss). Adds the block-builder document alongside the legacy
  // htmlContent so a template can carry either representation.
  await db.schema
    .alterTable("emailTemplates")
    .addColumn("blockJson", sql`longtext`)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse order. Indexes drop with their tables in MySQL, so no explicit
  // dropIndex is needed for the four new tables.
  await db.schema.alterTable("emailTemplates").dropColumn("blockJson").execute();
  await db.schema.dropTable("emailSuppression").ifExists().execute();
  await db.schema.dropTable("campaignEvents").ifExists().execute();
  await db.schema.dropTable("campaignRecipients").ifExists().execute();
  await db.schema.dropTable("emailCampaigns").ifExists().execute();
}
