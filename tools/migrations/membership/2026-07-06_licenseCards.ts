import { type Kysely, sql } from "kysely";

// PRT-03 domain print-audit persistence. A single net-new table in the
// membership database:
//
//   licenseCards — the queryable, campus-scoped audit row written on a CONFIRMED
//                  print of a CR80 ministerial-license card (Plan 06-04). Instead
//                  of a generic AuditLog blob, this is a first-class domain row so
//                  "who printed which person's which credential, on what template
//                  version, and here's the exact archived PDF" is directly
//                  answerable AND campus-scoped for reporting.
//
// Columns capture the full print event:
//   - `personId`            the member whose card was printed.
//   - `personOrdinationId`  the SPECIFIC credential that was printed.
//   - `campusId`            campus-scoped like ordinations — enables campus-scoped
//                           audit/reporting (the controller applies CampusScope).
//   - `templateId` + `templateVersion`  the licenseTemplate + its
//                           currentVersion AT PRINT TIME (so the exact rendered
//                           layout is reproducible from licenseTemplateVersions).
//   - `pdfRef`              the FileStorage key of the archived PDF blob.
//   - `createdBy`           the actor (userId) who confirmed the print.
//   - `createdAt`           when.
//
// Tenancy: churchId is the mandatory tenancy column (server-derived, never trusted
// from the request body). This is an APPEND-ONLY audit table — no OCC/version, no
// upsert; the repo INSERTs and reads churchId-first with removed=0.
//
// Conventions mirror 2026-07-01_personPhotoCrops.ts: char(11) ids, ENGINE=InnoDB,
// named indexes, bit(1) `removed` soft delete. The date prefix is strictly after
// 2026-07-02_licenseTemplates (the last applied membership migration) — Kysely
// rejects out-of-order migrations (project memory / RESEARCH Pitfall 4).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("licenseCards")
    .ifNotExists()
    .addColumn("id", sql`char(11)`, (col) => col.notNull().primaryKey())
    .addColumn("churchId", sql`char(11)`, (col) => col.notNull())
    .addColumn("personId", sql`char(11)`, (col) => col.notNull())
    .addColumn("personOrdinationId", sql`char(11)`, (col) => col.notNull())
    .addColumn("campusId", sql`char(11)`, (col) => col.notNull())
    .addColumn("templateId", sql`char(11)`, (col) => col.notNull())
    .addColumn("templateVersion", sql`int`, (col) => col.notNull())
    .addColumn("pdfRef", sql`varchar(500)`, (col) => col.notNull())
    .addColumn("createdAt", sql`datetime`, (col) => col.notNull())
    .addColumn("createdBy", sql`char(11)`)
    .addColumn("removed", sql`bit(1)`, (col) => col.notNull().defaultTo(sql`0`))
    .modifyEnd(sql`ENGINE=InnoDB`)
    .execute();

  // Per-person print history (newest-first reads in the repo).
  await db.schema
    .createIndex("idx_licenseCards_person")
    .on("licenseCards")
    .columns(["churchId", "personId"])
    .execute();

  // Campus-scoped reporting.
  await db.schema
    .createIndex("idx_licenseCards_campus")
    .on("licenseCards")
    .columns(["churchId", "campusId"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("licenseCards").ifExists().execute();
}
