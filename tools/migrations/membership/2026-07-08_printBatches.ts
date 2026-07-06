import { type Kysely, sql } from "kysely";

// PRT-02 / PRT-04 batch-render + card-lifecycle persistence. This migration:
//
//   1. Creates `printBatches` — a reproducible, poll-able batch entity. It stores
//      the provenance (`filterJson`, the LOCKED "store BOTH" audit decision — the
//      filter that produced the batch AND the resolved per-card rows), the render
//      progress (`status` + DB-backed `renderedCount`/`cardCount` numerator/
//      denominator so a concurrent poller reads live progress from the DB, not
//      in-memory), the per-person skips (`skippedJson`), and the assembled-PDF
//      FileStorage key (`pdfRef`).
//
//   2. ALTERs the Phase-6 `licenseCards` table to carry batch linkage
//      (`batchId`) + the draft/queued/printed/reissued/void status lifecycle
//      (`status`) plus the void/print audit stamps. Existing Phase-6 single-print
//      rows are written ONLY on a CONFIRMED print, so `status` defaults to
//      "printed" — legacy rows are correctly already-printed without a backfill.
//
// Conventions mirror 2026-07-06_licenseCards.ts verbatim: char(11) ids,
// ENGINE=InnoDB, named indexes, bit(1) `removed` soft delete. The date prefix is
// strictly after 2026-07-06_licenseCards (the last applied membership migration)
// — Kysely rejects out-of-order migrations (project memory / RESEARCH Pitfall 3).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("printBatches")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("name", sql`varchar(255)`)
    .addColumn("filterJson", sql`text`)
    .addColumn("status", sql`varchar(20)`, (col) => col.notNull().defaultTo("building"))
    .addColumn("cardCount", sql`int`, (col) => col.notNull().defaultTo(0))
    .addColumn("renderedCount", sql`int`, (col) => col.notNull().defaultTo(0))
    .addColumn("skippedJson", sql`text`)
    .addColumn("pdfRef", sql`varchar(500)`)
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("createdBy", sql`char(11)`)
    .addColumn("removed", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();

  // Recent-batches picker (kiosk): churchId-scoped, newest-first by createdAt.
  await db.schema
    .createIndex("idx_printBatches_church")
    .on("printBatches")
    .columns(["churchId", "createdAt"])
    .execute();

  // ── ALTER licenseCards: batch linkage + status lifecycle + void/print stamps ──
  //
  // `status` defaults to "printed" because existing Phase-6 rows are written ONLY
  // on a confirmed print (RESEARCH Pitfall 7) — batch-created rows explicitly set
  // "draft". `batchId` is null for Phase-6 single prints.
  await db.schema
    .alterTable("licenseCards")
    .addColumn("batchId", sql`char(11)`)
    .addColumn("status", sql`varchar(20)`, (col) => col.notNull().defaultTo("printed"))
    .addColumn("printedAt", sql`datetime`)
    .addColumn("voidReason", sql`varchar(500)`)
    .addColumn("voidedAt", sql`datetime`)
    .addColumn("voidedBy", sql`char(11)`)
    .execute();

  // Drives the print-station per-card list (loadByBatch).
  await db.schema
    .createIndex("idx_licenseCards_batch")
    .on("licenseCards")
    .columns(["churchId", "batchId"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_licenseCards_batch").on("licenseCards").ifExists().execute();
  await db.schema
    .alterTable("licenseCards")
    .dropColumn("batchId")
    .dropColumn("status")
    .dropColumn("printedAt")
    .dropColumn("voidReason")
    .dropColumn("voidedAt")
    .dropColumn("voidedBy")
    .execute();

  await db.schema.dropTable("printBatches").ifExists().execute();
}
