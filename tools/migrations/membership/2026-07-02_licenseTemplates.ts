import { type Kysely, sql } from "kysely";

// License-template domain foundation (TPL-03, TPL-04). Two net-new tables in the
// membership database:
//
//   licenseTemplates        — the live/current row for a CR80 ministerial-license
//                             card template. `layoutJson` is the current
//                             declarative layout (fast read/edit). Lifecycle
//                             columns support ONE global default per church plus
//                             optional per-ordination-type bindings (TPL-04):
//                             ordinationTypeId NULL = global; non-null = bound to
//                             a specific type. `active` toggles whether the
//                             template is in use; `removed` is the engineering
//                             soft-delete tombstone (mirrors the ordinations
//                             convention).
//
//   licenseTemplateVersions — immutable audit-grade snapshot history (TPL-03).
//                             Every save freezes the layout into a new row keyed
//                             UNIQUE(churchId, templateId, versionNumber). These
//                             rows are never updated — they are the reproduce-an-
//                             old-card record Phase 6 reads.
//
// TWO DISTINCT version concepts live on licenseTemplates (RESEARCH Pitfall 4):
//   - `currentVersion` (CONTENT/AUDIT version) bumps on every save and is
//     mirrored into licenseTemplateVersions.versionNumber.
//   - `version`        (OCC guard) backs updateWithVersion's optimistic-
//     concurrency check, exactly like personOrdinations.version. They are NOT the
//     same column and must never be conflated.
//
// There are NO enforced foreign keys in this codebase (FK-by-convention only),
// so migration ordering relative to ordinations is immaterial.
//
// Single-global-default + at-most-one-active-per-type are emulated with STORED
// generated flag columns inside UNIQUE indexes (MySQL has no native partial/
// filtered unique index, and the CASE expression fights Kysely generatedAlwaysAs,
// so they are added via raw ALTER TABLE sql — same trick as ordinations.activeFlag).

export async function up(db: Kysely<any>): Promise<void> {
  // ---- licenseTemplates: the live/current template row (TPL-03, TPL-04) ----
  await db.schema
    .createTable("licenseTemplates")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("name", sql`varchar(100)`, (col) => col.notNull())
    // NULL = global default applies to all; non-null = per-type binding (TPL-04).
    .addColumn("ordinationTypeId", sql`char(11)`)
    .addColumn("isDefault", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .addColumn("active", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`1`))
    // The current declarative layout (fast read/edit).
    .addColumn("layoutJson", sql`longtext`, (col) => col.notNull())
    // CONTENT/AUDIT version — bumps every save; mirrored into the snapshot table.
    .addColumn("currentVersion", sql`int`, (col) => col.notNull().defaultTo(sql`1`))
    // OCC guard for updateWithVersion — DISTINCT from currentVersion (Pitfall 4).
    .addColumn("version", sql`int`, (col) => col.notNull().defaultTo(sql`1`))
    .addColumn("removed", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("createdBy", sql`char(11)`)
    .addColumn("updatedAt", sql`datetime`)
    .addColumn("updatedBy", sql`char(11)`)
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();

  // Single-global-default enforcement (TPL-04). STORED generated column = 1 only
  // when isDefault=1 AND removed=0, else NULL; MySQL allows duplicate NULLs so at
  // most one non-removed default per church can exist. Added via raw sql (the
  // CASE expression fights Kysely's generatedAlwaysAs).
  await sql`ALTER TABLE licenseTemplates ADD COLUMN defaultFlag TINYINT GENERATED ALWAYS AS (CASE WHEN isDefault = 1 AND removed = 0 THEN 1 ELSE NULL END) STORED`.execute(db);

  await db.schema
    .createIndex("uq_licenseTemplates_default")
    .unique()
    .on("licenseTemplates")
    .columns(["churchId", "defaultFlag"])
    .execute();

  // At-most-one ACTIVE template per bound type (RESEARCH Open Q1 default). STORED
  // generated column = 1 only when active=1 AND removed=0, else NULL. NOTE: for
  // ordinationTypeId NULL rows MySQL treats the whole tuple as distinct when any
  // column is NULL, so multiple global (null-type) rows may be active at once —
  // this is INTENTIONAL and accepted (Open Q1); the single global DEFAULT is
  // still pinned by defaultFlag, so "one global default + per-type override" holds.
  await sql`ALTER TABLE licenseTemplates ADD COLUMN activeFlag TINYINT GENERATED ALWAYS AS (CASE WHEN active = 1 AND removed = 0 THEN 1 ELSE NULL END) STORED`.execute(db);

  await db.schema
    .createIndex("uq_licenseTemplates_active_type")
    .unique()
    .on("licenseTemplates")
    .columns(["churchId", "ordinationTypeId", "activeFlag"])
    .execute();

  // Church-wide lookup hot path.
  await db.schema
    .createIndex("idx_licenseTemplates_churchId")
    .on("licenseTemplates")
    .columns(["churchId"])
    .execute();

  // ---- licenseTemplateVersions: immutable audit history (TPL-03) ----
  await db.schema
    .createTable("licenseTemplateVersions")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("templateId", sql`char(11)`, (col) => col.notNull())
    // Matches licenseTemplates.currentVersion at save time.
    .addColumn("versionNumber", sql`int`, (col) => col.notNull())
    // Frozen snapshot of the layout at this version.
    .addColumn("layoutJson", sql`longtext`, (col) => col.notNull())
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("createdBy", sql`char(11)`)
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();

  // One snapshot per (church, template, version) — the immutable audit key.
  await db.schema
    .createIndex("uq_licenseTemplateVersions")
    .unique()
    .on("licenseTemplateVersions")
    .columns(["churchId", "templateId", "versionNumber"])
    .execute();

  // Per-template history reads (version list, newest-first).
  await db.schema
    .createIndex("idx_licenseTemplateVersions_template")
    .on("licenseTemplateVersions")
    .columns(["churchId", "templateId"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("licenseTemplateVersions").ifExists().execute();
  await db.schema.dropTable("licenseTemplates").ifExists().execute();
}
