import { type Kysely, sql } from "kysely";

// Phase-8 leadership-reports add-on: per-credential PAID / EXEMPT tracking on
// personOrdinations.
//
// The leadership roster (RPT-04/05) needs to surface, per credential, whether
// the annual license fee has been PAID and whether the holder is EXEMPT from it.
// Both are stored as tinyint(1) NOT NULL DEFAULT 0 booleans so every existing
// row defaults to "unpaid / not exempt" without a data backfill. They are
// written ONLY through the dedicated PersonOrdinationRepo.updatePaymentFlags
// path (never the status/grant updateWithVersion set-clause, which must not
// clobber them).
//
// The date prefix is strictly AFTER 2026-07-09_licenseCardsPdfRefNullable (the
// last-applied membership migration) — Kysely applies migrations in strict
// filename/ISO-date order and rejects an out-of-order insert.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE personOrdinations ADD COLUMN paid tinyint(1) NOT NULL DEFAULT 0, ADD COLUMN exempt tinyint(1) NOT NULL DEFAULT 0`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE personOrdinations DROP COLUMN paid, DROP COLUMN exempt`.execute(db);
}
