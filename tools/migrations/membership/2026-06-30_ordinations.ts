import { type Kysely, sql } from "kysely";

// Ordination domain foundation (ORD-01..04, 06, 07). Two net-new tables in the
// membership database:
//
//   ordinationTypes   — church-wide controlled vocabulary (NOT campus-scoped).
//                       The set of credentials a church can grant (Bishop,
//                       Pastor, ...). `active` (ORD-01) toggles whether a type
//                       is still offered; `removed` is the engineering soft
//                       delete. These are DISTINCT: `active` is product-level
//                       deactivation (a deactivated-but-not-removed type is
//                       still referenced vocabulary for historical rows),
//                       `removed` is an engineering tombstone (mirrors the
//                       userCampuses convention: createdAt datetime + removed
//                       bit(1)).
//
//   personOrdinations — campus-scoped assignment of an ordination type to a
//                       person (ORD-02). One person may hold several distinct
//                       ordinations and may be re-issued the same one after a
//                       prior grant is revoked, so there is NO over-broad
//                       unique on (person, type) — that would break ORD-03.
//
// Three mechanics this repo has never had before:
//
//   1. ORD-04 partial-unique emulation. MySQL has no native partial/filtered
//      unique index, so we add a STORED generated column `activeFlag` =
//      (status='active' AND removed=0 ? 1 : NULL) and put it inside a UNIQUE
//      (churchId, personId, ordinationTypeId, campusId, activeFlag). Two rows
//      that are BOTH active for the same tuple both carry activeFlag=1 and
//      collide; any revoked/suspended/removed row has activeFlag=NULL and MySQL
//      permits duplicate NULLs, so re-issue after revocation is allowed
//      (ORD-03 preserved). The column is added via raw ALTER TABLE rather than
//      the Kysely column builder: the CASE expression fights
//      `generatedAlwaysAs` (RESEARCH Open Q5), so raw sql is the lower-risk path.
//
//   2. ORD-07 optimistic concurrency. `version int NOT NULL DEFAULT 1`; repos
//      bump it on every write and guard updates with the read-time version.
//
//   3. ORD-06 nullable lifecycle dates. `grantedDate`/`expirationDate` are
//      `date` (NOT datetime — Pitfall 6: these are calendar dates, no clock
//      component) and nullable (a pending/未granted credential has no dates).
//
// Decision notes (resolving RESEARCH open questions per its recommendations):
//   (1) activeFlag keys on the literal status='active' only — widening to also
//       treat pending/suspended as "occupying" is a one-line CASE change later.
//   (2) credentialNumber is nullable + NON-unique for Phase 2: a unique index
//       would block re-issue reusing a number; we only index it for lookup.
//   (3) status is stored as varchar(20), NOT a MySQL ENUM (ORD-05; avoids ALTERs
//       to evolve the lifecycle vocabulary).

export async function up(db: Kysely<any>): Promise<void> {
  // ---- ordinationTypes: church-wide controlled vocabulary (ORD-01) ----
  await db.schema
    .createTable("ordinationTypes")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("name", sql`varchar(100)`, (col) => col.notNull())
    .addColumn("code", sql`varchar(50)`, (col) => col.notNull())
    .addColumn("sortOrder", sql`int`)
    .addColumn("description", sql`varchar(500)`)
    .addColumn("active", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`1`))
    .addColumn("removed", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();

  await db.schema
    .createIndex("idx_ordinationTypes_churchId")
    .on("ordinationTypes")
    .columns(["churchId"])
    .execute();

  // Per-church code uniqueness + seed idempotency key (upsert-by-code).
  await db.schema
    .createIndex("idx_ordinationTypes_code")
    .unique()
    .on("ordinationTypes")
    .columns(["churchId", "code"])
    .execute();

  // ---- personOrdinations: campus-scoped assignment (ORD-02..04, 06, 07) ----
  await db.schema
    .createTable("personOrdinations")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("campusId", sql`char(11)`, (col) => col.notNull())
    .addColumn("personId", sql`char(11)`, (col) => col.notNull())
    .addColumn("ordinationTypeId", sql`char(11)`, (col) => col.notNull())
    .addColumn("status", sql`varchar(20)`, (col) => col.notNull())
    .addColumn("credentialNumber", sql`varchar(100)`)
    .addColumn("grantedDate", sql`date`)
    .addColumn("expirationDate", sql`date`)
    .addColumn("version", sql`int`, (col) => col.notNull().defaultTo(sql`1`))
    .addColumn("notes", sql`varchar(500)`)
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("createdBy", sql`char(11)`)
    .addColumn("updatedAt", sql`datetime`)
    .addColumn("updatedBy", sql`char(11)`)
    .addColumn("removed", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();

  // ORD-04 partial-unique emulation: STORED generated column. NULL when the row
  // is not active/removed so MySQL's "duplicate NULLs allowed" rule permits
  // re-issue; 1 when active so two BOTH-active rows for the same tuple collide.
  // Added via raw sql (the CASE expression fights Kysely's generatedAlwaysAs).
  await sql`ALTER TABLE personOrdinations ADD COLUMN activeFlag TINYINT GENERATED ALWAYS AS (CASE WHEN status = 'active' AND removed = 0 THEN 1 ELSE NULL END) STORED`.execute(db);

  // ORD-04: at most one ACTIVE ordination per (church, person, type, campus).
  await db.schema
    .createIndex("uq_personOrdinations_active")
    .unique()
    .on("personOrdinations")
    .columns(["churchId", "personId", "ordinationTypeId", "campusId", "activeFlag"])
    .execute();

  // Campus scope hot path (applyCampusScope churchId + campusId filter).
  await db.schema
    .createIndex("idx_personOrdinations_church_campus")
    .on("personOrdinations")
    .columns(["churchId", "campusId"])
    .execute();

  // Per-person reads / joins to people.
  await db.schema
    .createIndex("idx_personOrdinations_person")
    .on("personOrdinations")
    .columns(["churchId", "personId"])
    .execute();

  // Credential-number lookup (NON-unique: re-issue may reuse a number).
  await db.schema
    .createIndex("idx_personOrdinations_credentialNumber")
    .on("personOrdinations")
    .columns(["churchId", "credentialNumber"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Drop child-by-convention (personOrdinations references ordinationTypeId).
  await db.schema.dropTable("personOrdinations").ifExists().execute();
  await db.schema.dropTable("ordinationTypes").ifExists().execute();
}
