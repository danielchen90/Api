import { type Kysely, sql } from "kysely";

// Add a `country` column to campuses.
//
// The 2026-06-04_campus migration promoted campuses to a full address entity but
// only covered US-shaped fields (address1/2, city, state, zip). The Elvanto
// import surfaces international campuses (Jamaica, Bahamas, Canada, Trinidad)
// whose country cannot be represented in `state`, so a dedicated nullable column
// is added. Matches the varchar(255) width of the sibling address columns.
//
// The date prefix is strictly AFTER 2026-07-10_ordinationPaidExempt (the
// last-applied membership migration) — Kysely applies migrations in strict
// filename/ISO-date order and rejects an out-of-order insert.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("campuses").addColumn("country", sql`varchar(255)`).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("campuses").dropColumn("country").execute();
}
