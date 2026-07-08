import { type Kysely, sql } from "kysely";

// Add latitude/longitude to campuses for map display.
//
// The dedicated Campuses section renders campus locations on an interactive
// (OpenStreetMap/Leaflet) map. Coordinates are geocoded server-side from the
// campus address via the existing free OSM GeoHelper and stored here. Mirrors
// the churches.latitude/longitude columns (2026-04-03_initial_schema, float).
//
// The date prefix is strictly AFTER 2026-07-11_campusCountry (the last-applied
// membership migration) — Kysely applies migrations in strict filename/ISO-date
// order and rejects an out-of-order insert.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("campuses")
    .addColumn("latitude", sql`float`)
    .addColumn("longitude", sql`float`)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("campuses").dropColumn("latitude").dropColumn("longitude").execute();
}
