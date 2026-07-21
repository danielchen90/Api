import { type Kysely, sql } from "kysely";

// Per-campus public-website content model (CMS-01).
//
//   campusContent — one row per (churchId, campusId, contentType). A NULL
//                   campusId is the ORG DEFAULT for that contentType; a non-null
//                   campusId is that campus's SPARSE override (only changed fields
//                   are stored, so an org-default change propagates live to any
//                   campus that has not overridden that field). `content` is the
//                   declarative JSON blob (longtext); `version` is the OCC guard
//                   backing CampusContentRepo.updateWithVersion (exactly like
//                   personOrdinations.version / licenseTemplates.version).
//
// There are NO enforced foreign keys in this codebase (FK-by-convention only), so
// migration ordering relative to campuses is immaterial.
//
// CRITICAL ORDERING (RESEARCH Pitfall 7): the last-applied membership migration is
// 2026-07-18_licenseCardsSortOrder.ts. Kysely applies migrations in strict
// filename/ISO-date order and REJECTS an out-of-order insert, so this file is
// hand-dated strictly AFTER it — 2026-07-22 (NOT `yarn migrate:create`, which
// would stamp today and could sort before the last-applied set).
//
// NULL-SAFE ORG-DEFAULT UNIQUENESS (RESEARCH Pitfall 5): a plain
// UNIQUE(churchId, campusId, contentType) does NOT enforce uniqueness for the
// org-default rows because MySQL treats a NULL campusId as distinct from any other
// NULL — two org defaults for the same contentType could coexist. We use the SAME
// STORED-generated-column trick licenseTemplates uses: a STORED generated column
// that COALESCEs a NULL campusId to a fixed sentinel, then put the UNIQUE index on
// (churchId, campusKey, contentType). The sentinel collapses all org-default rows
// for a given (church, contentType) into one unique tuple.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("campusContent")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    // NULL = the ORG DEFAULT for this contentType; non-null = a campus override.
    .addColumn("campusId", sql`char(11)`)
    .addColumn("contentType", sql`varchar(100)`, (col) => col.notNull())
    // Declarative content JSON (sparse override for a campus / full org default).
    .addColumn("content", sql`longtext`, (col) => col.notNull())
    // OCC guard for updateWithVersion — bumps on every successful update.
    .addColumn("version", sql`int`, (col) => col.notNull().defaultTo(sql`1`))
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("updatedAt", sql`datetime`)
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();

  // STORED generated key that makes the org-default (NULL campusId) row unique:
  // COALESCE(campusId,'~ORG~') collapses every NULL-campus row for a given
  // (churchId, contentType) to the same sentinel so the UNIQUE index below rejects
  // a second org default. Added via raw ALTER TABLE (mirrors licenseTemplates'
  // defaultFlag trick — the COALESCE expression fights Kysely's generatedAlwaysAs).
  await sql`ALTER TABLE campusContent ADD COLUMN campusKey CHAR(11) GENERATED ALWAYS AS (COALESCE(campusId, '~ORG~')) STORED`.execute(db);

  // One row per (church, campus-or-org-default, contentType). The generated
  // campusKey makes the org-default row NULL-safe-unique (Pitfall 5).
  await db.schema
    .createIndex("uq_campusContent_scope")
    .unique()
    .on("campusContent")
    .columns(["churchId", "campusKey", "contentType"])
    .execute();

  // Church-wide + per-campus lookup hot path (loadOrgDefault / loadForCampus).
  await db.schema
    .createIndex("idx_campusContent_church")
    .on("campusContent")
    .columns(["churchId", "campusId"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("campusContent").ifExists().execute();
}
