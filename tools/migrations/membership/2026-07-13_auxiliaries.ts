import { type Kysely, sql } from "kysely";

// Auxiliaries: the formal "logical group across campuses" structure.
//
// Church programs (New Anointing, Portraits of the Word, Tech Team, …) run as
// one auxiliary with a per-campus group instance each. Previously these were
// only related by an identical group NAME (the Elvanto underscore convention,
// now cleaned). This introduces a real umbrella entity + a groups.auxiliaryId
// FK so instances are structurally linked — enabling cross-campus rollups and a
// future auxiliary-scoped "president" role.
//
// A group with auxiliaryId + campusId = a campus instance of an auxiliary;
// auxiliaryId + no campusId = an international/HQ instance; no auxiliaryId =
// a standalone group (campus congregations, admin bodies).
//
// Date prefix strictly AFTER 2026-07-12_campusLatLng (Kysely strict order).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("auxiliaries")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`)
    .addColumn("name", sql`varchar(100)`)
    .addColumn("description", sql`text`)
    .addColumn("importKey", sql`varchar(255)`)
    .addColumn("removed", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();
  await db.schema.createIndex("idx_auxiliaries_churchId").on("auxiliaries").columns(["churchId"]).execute();

  await db.schema.alterTable("groups").addColumn("auxiliaryId", sql`char(11)`).execute();
  await db.schema.createIndex("idx_groups_auxiliaryId").on("groups").columns(["auxiliaryId"]).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("idx_groups_auxiliaryId").on("groups").ifExists().execute();
  await db.schema.alterTable("groups").dropColumn("auxiliaryId").execute();
  await db.schema.dropIndex("idx_auxiliaries_churchId").on("auxiliaries").ifExists().execute();
  await db.schema.dropTable("auxiliaries").ifExists().execute();
}
