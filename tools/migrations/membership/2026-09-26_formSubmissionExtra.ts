import { type Kysely, sql } from "kysely";

// Next Steps forms (website redesign 2026-09): the login-free submit now also accepts
// "visit" | "salvation" | "baptism" | "serve" | "discipleship". Type-specific extras (for "visit":
// visitDate, partySize, notes) are stored as a small JSON document in `extra` so new form types
// never need another column. NULL for every existing row.
//
// Hand-dated 2026-09-26: strictly after the last membership migration (2026-07-24_formSubmissionCampusId).
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE formSubmissions ADD COLUMN extra TEXT NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE formSubmissions DROP COLUMN extra`.execute(db);
}
