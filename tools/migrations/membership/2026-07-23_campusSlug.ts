import { type Kysely, sql } from "kysely";

// Public-website campus slug + rename-alias model (SITE-02/03, MAP-01..04).
//
//   campuses.slug   — a STABLE, human-readable per-church slug decoupled from the
//                     mutable display `name`, so renaming a campus does NOT change
//                     its public URL (/locations/[slug], sitemap, map "View campus").
//                     Nullable here on purpose: this migration is SCHEMA-ONLY; the
//                     concrete backfill that fills these nulls for the ~23 existing
//                     campuses is a DATA script (tools/backfill-campus-slugs.ts),
//                     run once at deploy. The column just needs to exist + be
//                     queryable + be uniquely-indexed after this migration.
//
//   campusSlugAlias — maps an OLD slug -> the CURRENT campus id, so a rename keeps
//                     the previous URL alive as a 301 alias (SC#2). Populated later
//                     on rename (NOT by the first backfill). FK-by-convention only
//                     (there are NO enforced foreign keys in this codebase).
//
// CRITICAL ORDERING (RESEARCH Pitfall 7): the last-applied membership migration is
// 2026-07-22_campusContent.ts. Kysely applies migrations in strict filename/ISO-date
// order and REJECTS an out-of-order insert, so this file is hand-dated strictly
// AFTER it — 2026-07-23 (NOT `yarn migrate:create`, which stamps today and could
// sort before the last-applied set).
export async function up(db: Kysely<any>): Promise<void> {
  // Stable per-church slug on the existing campuses table (nullable — backfilled live).
  await db.schema
    .alterTable("campuses")
    .addColumn("slug", sql`varchar(120)`)
    .execute();

  // One slug per church. NULLs are treated as distinct by MySQL, so the many
  // not-yet-backfilled NULL slugs coexist happily; uniqueness bites once slugs land.
  await db.schema
    .createIndex("uq_campuses_slug")
    .unique()
    .on("campuses")
    .columns(["churchId", "slug"])
    .execute();

  // Old-slug -> current-campus-id alias table (feeds a 301 in the UI layer on rename).
  await db.schema
    .createTable("campusSlugAlias")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("slug", sql`varchar(120)`, (col) => col.notNull())
    .addColumn("campusId", sql`char(11)`, (col) => col.notNull())
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();

  // One alias per (church, old-slug) — a given retired slug resolves to exactly one campus.
  await db.schema
    .createIndex("uq_campusSlugAlias")
    .unique()
    .on("campusSlugAlias")
    .columns(["churchId", "slug"])
    .execute();

  // Reverse lookup: all aliases pointing at a campus (e.g. to prune on delete).
  await db.schema
    .createIndex("idx_campusSlugAlias_campus")
    .on("campusSlugAlias")
    .columns(["churchId", "campusId"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("campusSlugAlias").ifExists().execute();
  await db.schema.dropIndex("uq_campuses_slug").on("campuses").ifExists().execute();
  await db.schema.alterTable("campuses").dropColumn("slug").execute();
}
