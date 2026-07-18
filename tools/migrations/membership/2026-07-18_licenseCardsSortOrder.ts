import { type Kysely, sql } from "kysely";

// Add a deterministic `sortOrder` column to licenseCards so a print batch's
// per-card list (loadByBatch) returns rows in the EXACT order the cards were
// resolved/inserted — which is the assembled-PDF page order.
//
// WHY: `createdAt` is MySQL `datetime` (whole-second precision). A batch inserts
// all of its draft cards in a sub-second loop, so every row shares the same
// `createdAt` and `ORDER BY createdAt asc` is non-deterministic. The print-station
// grid pairs thumbnail[i] (PDF page order) with card[i] (loadByBatch order), so the
// tie scrambled the pairing → names shown under the wrong pictures. `sortOrder`
// (the card's index at insert time) gives a stable, page-aligned ordering.
//
// Existing rows default to 0 (legacy single-print rows have batchId=null; old
// batches keep the createdAt fallback tiebreaker in loadByBatch). Going-forward
// batches stamp the real index in PrintBatchController.create().
//
// CRITICAL ORDERING: the date prefix is strictly AFTER 2026-07-15_personDateAdded
// (the last-applied membership migration). Kysely applies migrations in strict
// filename/ISO-date order and rejects an out-of-order insert — this file was
// hand-authored (NOT `yarn migrate:create`, which would stamp today and could sort
// before the last-applied set).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("licenseCards")
    .addColumn("sortOrder", sql`int`, (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("licenseCards").dropColumn("sortOrder").execute();
}
