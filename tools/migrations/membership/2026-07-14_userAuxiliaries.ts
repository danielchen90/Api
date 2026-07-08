import { type Kysely, sql } from "kysely";

// Auxiliary-scoping foundation: persist which auxiliaries a user "presides" over.
// Mirrors userCampuses (2026-06-29) exactly — the per-request AuxiliaryScopeHelper
// reads this table via the (churchId, userId) index to restrict an Auxiliary
// President to only their auxiliaries' cross-campus rollups.
//
// Date prefix strictly AFTER 2026-07-13_auxiliaries (Kysely strict order).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("userAuxiliaries")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("userId", sql`char(11)`, (col) => col.notNull())
    .addColumn("auxiliaryId", sql`char(11)`, (col) => col.notNull())
    .addColumn("addedBy", sql`char(11)`)
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("removed", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();

  await db.schema.createIndex("idx_userAuxiliaries_church_user").on("userAuxiliaries").columns(["churchId", "userId"]).execute();
  await db.schema.createIndex("idx_userAuxiliaries_unique").unique().on("userAuxiliaries").columns(["churchId", "userId", "auxiliaryId"]).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("userAuxiliaries").ifExists().execute();
}
