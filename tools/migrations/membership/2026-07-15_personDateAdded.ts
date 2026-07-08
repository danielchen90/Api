import { type Kysely, sql } from "kysely";

// Add a nullable `dateAdded` column to people.
//
// The admin dashboard's weekly "new members" trend needs a per-person created
// date. Existing rows legitimately stay NULL — there is no historical signup
// timestamp to backfill, so the trend (and the UI) is honestly going-forward
// only: PersonRepo.create() stamps dateAdded=NOW() on every NEW insert from this
// deploy onward, and loadNewMembersTrend() filters `dateAdded IS NOT NULL`.
//
// CRITICAL ORDERING: the date prefix is strictly AFTER 2026-07-14_userAuxiliaries
// (the last-applied membership migration). Kysely applies migrations in strict
// filename/ISO-date order and rejects an out-of-order insert — this file was
// hand-authored (NOT `yarn migrate:create`, which would stamp today and sort
// BEFORE the last-applied set, breaking the whole batch).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("people").addColumn("dateAdded", sql`datetime`).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("people").dropColumn("dateAdded").execute();
}
