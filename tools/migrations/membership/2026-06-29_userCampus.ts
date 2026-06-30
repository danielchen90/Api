import { type Kysely, sql } from "kysely";

// Campus-scoping foundation (PERM-01): persist which campuses a user is
// assigned to within a church. A user may belong to one or more campuses; the
// per-request scope resolver reads this table via the (churchId, userId) index.
//
// `removed bit(1)` makes assignments revocable while keeping history (soft
// delete), matching the newest-table convention (createdAt + removed). The
// UNIQUE (churchId, userId, campusId) index prevents duplicate assignments.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("userCampuses")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("userId", sql`char(11)`, (col) => col.notNull())
    .addColumn("campusId", sql`char(11)`, (col) => col.notNull())
    .addColumn("addedBy", sql`char(11)`)
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("removed", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();

  // Per-request resolver hot path: loadCampusIdsForUser(churchId, userId).
  await db.schema
    .createIndex("idx_userCampuses_church_user")
    .on("userCampuses")
    .columns(["churchId", "userId"])
    .execute();

  // Prevent duplicate assignments of the same campus to the same user.
  await db.schema
    .createIndex("idx_userCampuses_unique")
    .unique()
    .on("userCampuses")
    .columns(["churchId", "userId", "campusId"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("userCampuses").ifExists().execute();
}
