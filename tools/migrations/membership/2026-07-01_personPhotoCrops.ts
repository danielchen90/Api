import { type Kysely, sql } from "kysely";

// PHO-04 "store-once, re-crop via transform" persistence. A single net-new table
// in the membership database:
//
//   personPhotoCrops — the normalized license-crop TRANSFORM for a person's
//                      stored member photo. Instead of materializing a SECOND
//                      cropped image file, we persist a tiny normalized rect
//                      (cropX/Y/Width/Height in 0..1 of the source image) plus an
//                      optional rotation. Phase 6 re-applies this transform to the
//                      single stored member photo to render the CR80 card photo at
//                      any output resolution — no duplicate storage, resolution-
//                      independent.
//
// Tenancy + uniqueness:
//   - churchId is the mandatory tenancy column (server-derived, never trusted
//     from the request body).
//   - `purpose` (default 'license') future-proofs additional crop intents
//     ('member', ...) without a schema change.
//   - UNIQUE (churchId, personId, purpose) makes the crop an UPSERT key: exactly
//     one license crop per person. The repo probes this tuple and UPDATEs in
//     place rather than relying on ON DUPLICATE KEY.
//
//   `sourceUpdated` records person.photoUpdated AT CROP TIME so Phase 6 can detect
//   a STALE crop (the underlying member photo changed after the crop was saved).
//
// Conventions mirror 2026-06-30_ordinations.ts: char(11) ids, ENGINE=InnoDB,
// named indexes, bit(1) `removed` soft delete. Crop fields are decimal(7,5) — a
// normalized 0..1 value needs sub-pixel precision but a tiny range, so a small
// fixed-point decimal is exact and cheap (the repo coerces the driver's string
// DECIMAL back to a number on read).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("personPhotoCrops")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("personId", sql`char(11)`, (col) => col.notNull())
    .addColumn("purpose", sql`varchar(20)`, (col) => col.notNull().defaultTo("license"))
    .addColumn("cropX", sql`decimal(7,5)`, (col) => col.notNull())
    .addColumn("cropY", sql`decimal(7,5)`, (col) => col.notNull())
    .addColumn("cropWidth", sql`decimal(7,5)`, (col) => col.notNull())
    .addColumn("cropHeight", sql`decimal(7,5)`, (col) => col.notNull())
    .addColumn("rotation", sql`smallint`, (col) => col.notNull().defaultTo(0))
    .addColumn("sourceUpdated", sql`datetime`)
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("createdBy", sql`char(11)`)
    .addColumn("updatedAt", sql`datetime`)
    .addColumn("updatedBy", sql`char(11)`)
    .addColumn("removed", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();

  // One license crop per person — the upsert key (PHO-04).
  await db.schema
    .createIndex("idx_personPhotoCrops_purpose")
    .unique()
    .on("personPhotoCrops")
    .columns(["churchId", "personId", "purpose"])
    .execute();

  // Per-person reads.
  await db.schema
    .createIndex("idx_personPhotoCrops_person")
    .on("personPhotoCrops")
    .columns(["churchId", "personId"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("personPhotoCrops").ifExists().execute();
}
