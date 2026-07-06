import { type Kysely, sql } from "kysely";

// Phase-7 batch fix: make `licenseCards.pdfRef` NULLABLE.
//
// `pdfRef` was introduced in 2026-07-06_licenseCards.ts as NOT NULL because a
// Phase-6 card row was written ONLY on a CONFIRMED print, which always has an
// archived-PDF FileStorage key. Phase 7 (07-04 PrintBatchController) persists
// DRAFT `licenseCards` rows up-front — one per resolved card, IN CARD ORDER,
// BEFORE the batch renders — so those rows legitimately have no `pdfRef` yet
// (renderBatch stamps it later via updateStatus -> "queued"/"reissued"). Under
// STRICT_TRANS_TABLES the draft INSERT then fails with ER_NO_DEFAULT_FOR_FIELD
// ("Field 'pdfRef' doesn't have a default value").
//
// Relaxing the column to NULL is backward-compatible: confirmed single prints
// and completed batch cards still set `pdfRef`; only the transient draft state
// stores NULL. The date prefix is strictly after 2026-07-08_printBatches (the
// last-applied membership migration) — Kysely rejects out-of-order migrations.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE licenseCards MODIFY pdfRef varchar(500) NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE licenseCards MODIFY pdfRef varchar(500) NOT NULL`.execute(db);
}
