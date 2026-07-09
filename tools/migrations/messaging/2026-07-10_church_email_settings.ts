import { type Kysely, sql } from "kysely";

// DLV-02 — per-church email identity (Phase 11, Plan 01). One net-new
// churchId-scoped `churchEmailSettings` table in the `messaging` database: the
// from-name / from-email / reply-to a church sends campaigns under. ONE row per
// church (a UNIQUE index on churchId enforces the upsert), so the repo can
// loadByChurch → update-or-create.
//
// Conventions mirror 2026-07-09_saved_audiences.ts VERBATIM: char(11) ids, a
// named index, .modifyEnd ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 (MANDATORY —
// `fromName` carries a user-typed string). No native MySQL json/enum. The date
// prefix 2026-07-10 sorts strictly AFTER the last-applied messaging migration
// 2026-07-09_saved_audiences.ts — Kysely rejects out-of-order migrations
// (project memory / RESEARCH Pitfall 3).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("churchEmailSettings")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("fromName", sql`varchar(255)`)
    .addColumn("fromEmail", sql`varchar(255)`)
    .addColumn("replyTo", sql`varchar(255)`)
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("updatedAt", sql`datetime`)
    .modifyEnd(sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    .execute();

  // ONE row per church — the upsert key.
  await db.schema
    .createIndex("idx_churchEmailSettings_church")
    .on("churchEmailSettings")
    .column("churchId")
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // The index drops with the table in MySQL, so no explicit dropIndex is needed.
  await db.schema.dropTable("churchEmailSettings").ifExists().execute();
}
