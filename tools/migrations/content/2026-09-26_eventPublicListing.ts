import { type Kysely, sql } from "kysely";

// Public events feed (website redesign 2026-09): an explicit per-event opt-in to the public
// website, plus the worship center it belongs to and the visitor-facing extras.
//
//   publicListing   TINYINT(1) NOT NULL DEFAULT 0  only rows with 1 ever reach
//                                                  GET /content/events/public/:churchId
//   campusId        CHAR(11) NULL                  NULL = network-wide (all centers)
//   location        VARCHAR(255) NULL              free-text place ("Fellowship hall")
//   registrationUrl VARCHAR(500) NULL              external sign-up link (http/https)
//   image           VARCHAR(500) NULL              optional image link for the card
//
// campusId references membership.campuses by convention only (separate database, no FK).
// Existing events default to publicListing = 0, so nothing becomes public by this migration.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE events
    ADD COLUMN campusId CHAR(11) NULL,
    ADD COLUMN publicListing TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN location VARCHAR(255) NULL,
    ADD COLUMN registrationUrl VARCHAR(500) NULL,
    ADD COLUMN image VARCHAR(500) NULL`.execute(db);

  await db.schema
    .createIndex("idx_events_church_public")
    .on("events")
    .columns(["churchId", "publicListing", "campusId"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_events_church_public").on("events").ifExists().execute();
  await sql`ALTER TABLE events
    DROP COLUMN campusId,
    DROP COLUMN publicListing,
    DROP COLUMN location,
    DROP COLUMN registrationUrl,
    DROP COLUMN image`.execute(db);
}
