import { type Kysely, sql } from "kysely";

// The CRM tables were created with utf8mb4_unicode_ci, but production's people table (and the
// database default) is utf8mb4_0900_ai_ci, so every CRM query that joins people failed with
// "Illegal mix of collations". Convert each CRM table to whatever collation people.id uses here
// (a no-op where they already match, e.g. local databases on unicode_ci).
//
// Hand-dated 2026-10-10: after 2026-10-09_crmEvents.
const TABLES = [
  "crmProfiles", "crmNotes", "crmFacts", "crmTags", "crmPersonTags", "crmActivities", "crmSyncState", "crmBotChecks",
  "crmEvents", "crmEventRegistrations", "crmEventEmails", "crmEventEmailSends"
];

export async function up(db: Kysely<any>): Promise<void> {
  const row = await sql<{ c: string }>`SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'people' AND COLUMN_NAME = 'id'`.execute(db);
  const collation = row.rows[0]?.c;
  if (!collation || !/^utf8mb4_[a-z0-9_]+$/.test(collation)) return;
  for (const t of TABLES) {
    const cur = await sql<{ c: string }>`SELECT TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t}`.execute(db);
    if (!cur.rows.length || cur.rows[0].c === collation) continue;
    await sql.raw(`ALTER TABLE ${t} CONVERT TO CHARACTER SET utf8mb4 COLLATE ${collation}`).execute(db);
  }
}

export async function down(): Promise<void> {
  // Nothing to undo: matching the people table is the correct state.
}
