import { type Kysely, sql } from "kysely";

// Login-free forms backend (FRM-01..04) — campus tag + minimal-field columns on
// formSubmissions.
//
// The existing formSubmissions table carries only the workflow/questions path
// (formId/contentType/contentId + a separate answers table). The public
// prayer/contact submit (Plan 20-03) stores a handful of MINIMAL fields inline so
// the campus-scoped inbox READ stays trivial (a single scoped SELECT, no answers
// join): campusId + submissionType tag the row, unread drives the inbox badge, and
// submitterName/Email/Phone/message hold the visitor-provided content. The heavier
// questions/answers path is UNTOUCHED — every new column is nullable.
//
//   campusId       — CHAR(11) NULL. The campus this submission belongs to; the
//                    campus-scoped inbox READ (CampusScopeHelper + applyCampusScope)
//                    filters on it. A DATA TAG only — never trusted for authorization
//                    (RESEARCH Pitfall 4); it comes from the trusted submit ROUTE.
//   submissionType — VARCHAR(30) NULL, "prayer" | "contact".
//   unread         — TINYINT(1) NOT NULL DEFAULT 1; the inbox unread badge.
//   submitterName / submitterEmail / submitterPhone / message — the visitor's own input.
//
// There are NO enforced foreign keys in this codebase (FK-by-convention only), so
// ordering relative to campuses is immaterial.
//
// CRITICAL ORDERING (RESEARCH Pitfall / Kysely): migrations apply in strict
// filename/ISO-date order and Kysely REJECTS an out-of-order insert. This file is
// hand-dated 2026-07-24 — strictly AFTER plan 20-01's 2026-07-23_campusSlug and the
// last-applied 2026-07-22_campusContent (NOT `yarn migrate:create`, which would stamp
// today and could sort before the last-applied set).
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE formSubmissions
    ADD COLUMN campusId CHAR(11) NULL,
    ADD COLUMN submissionType VARCHAR(30) NULL,
    ADD COLUMN unread TINYINT(1) NOT NULL DEFAULT 1,
    ADD COLUMN submitterName VARCHAR(200) NULL,
    ADD COLUMN submitterEmail VARCHAR(200) NULL,
    ADD COLUMN submitterPhone VARCHAR(50) NULL,
    ADD COLUMN message TEXT NULL`.execute(db);

  // Campus-scoped inbox read hot path (loadInboxScoped filters churchId FIRST, then
  // applyCampusScope layers the campusId IN (...) set on top).
  await db.schema
    .createIndex("idx_formSubmissions_church_campus")
    .on("formSubmissions")
    .columns(["churchId", "campusId"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_formSubmissions_church_campus").on("formSubmissions").ifExists().execute();
  await sql`ALTER TABLE formSubmissions
    DROP COLUMN campusId,
    DROP COLUMN submissionType,
    DROP COLUMN unread,
    DROP COLUMN submitterName,
    DROP COLUMN submitterEmail,
    DROP COLUMN submitterPhone,
    DROP COLUMN message`.execute(db);
}
