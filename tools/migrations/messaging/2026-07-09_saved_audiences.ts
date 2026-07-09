import { type Kysely, sql } from "kysely";

// AUD-09 — a reusable NAMED audience (Phase 10, Plan 04). One net-new
// churchId-scoped `savedAudiences` table in the `messaging` database. One up(),
// one down(). No behavioral code — the table stores ONLY the audience DESCRIPTOR
// (label + audienceType + targetId + filterJson), never a resolved person list,
// so a saved audience is re-scoped to the CURRENT caller at run time (a saved
// "whole church" yields different sets for a Campus Admin vs a Leadership Admin —
// correct by design, RESEARCH Open Q3).
//
// Conventions mirror 2026-07-08_email_campaigns.ts VERBATIM: char(11) ids, a
// named index, bit(1) `removed` soft delete, status/type as varchar (NOT a MySQL
// ENUM). ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 is MANDATORY — `label` carries a
// user-typed string. `filterJson` is text (NO native MySQL json). The date prefix
// 2026-07-09 sorts strictly AFTER the last-applied messaging migration
// 2026-07-08_email_campaigns.ts — Kysely rejects out-of-order migrations
// (project memory / RESEARCH Pitfall 3).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("savedAudiences")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("label", sql`varchar(255)`, (col) => col.notNull())
    // audienceType: church/campus/group/auxiliary — varchar convention, NOT a
    // MySQL ENUM, so the set evolves without ALTERs.
    .addColumn("audienceType", sql`varchar(20)`)
    .addColumn("targetId", sql`char(11)`)
    // filterJson: raw descriptor string (NO native json).
    .addColumn("filterJson", sql`text`)
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("createdBy", sql`char(11)`)
    .addColumn("removed", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .modifyEnd(sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    .execute();

  // Church-scoped list drain (churchId + removed).
  await db.schema
    .createIndex("idx_savedAudiences_church_removed")
    .on("savedAudiences")
    .columns(["churchId", "removed"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // The index drops with the table in MySQL, so no explicit dropIndex is needed.
  await db.schema.dropTable("savedAudiences").ifExists().execute();
}
