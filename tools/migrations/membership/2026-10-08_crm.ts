import { type Kysely, sql } from "kysely";

// The ministry-wide CRM (2026-10). HURO now holds a record for EVERY Mary Banks ID, church member
// or not, plus what the ministry learns about each person and what they do across the sites.
//
//   people.mbidSub       the Mary Banks ID (Keycloak) `sub` this church record belongs to. Set by the
//                        Keycloak sync (CrmSyncService) or when a signed-in member is linked. One
//                        Mary Banks ID maps to at most one person per church (unique per church).
//   people.source        where the record came from: mbid | capture | event | globalchurch | NULL
//                        (NULL = an existing church record, entered before the CRM).
//
//   crmProfiles          one row per person: what the ministry knows that the stock people table
//                        has no column for (country, time zone, languages, ministry role, contact
//                        consent) and the AI-written summary of the person.
//   crmNotes             dated notes and quick captures (pasted conversations, screenshots).
//   crmFacts             short facts pulled out of notes: prayer requests, needs, interests, follow-ups.
//   crmTags/crmPersonTags  free tags for grouping people.
//   crmActivities        what the person did on the other sites (courses, books, prayer requests,
//                        groups, viewing, Ask Mary topics), refreshed by CrmActivitySync. Unique per
//                        (person, site, type, refKey) so a re-pull updates instead of duplicating.
//   crmSyncState         cursors and last-run markers for the sync jobs.
//   crmBotChecks         one verdict per Mary Banks ID account: is this a spam sign-up (random-letter
//                        names registered with a stranger's email)? Bots get no CRM record.
//
// Contacts created by the sync carry membershipStatus "Contact" and no campus, so campus-scoped
// admins never see them and whole-church email audiences leave them out (PersonRepo.loadForAudience).
//
// Hand-dated 2026-10-08: strictly after the last membership migration (2026-09-27_mbidMemberAccounts).
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE people ADD COLUMN mbidSub VARCHAR(64) NULL, ADD COLUMN source VARCHAR(30) NULL`.execute(db);
  await sql`CREATE UNIQUE INDEX uq_people_church_mbidSub ON people (churchId, mbidSub)`.execute(db);
  await sql`CREATE INDEX idx_people_church_email ON people (churchId, email)`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS crmProfiles (
    personId CHAR(11) NOT NULL PRIMARY KEY,
    churchId CHAR(11) NOT NULL,
    country VARCHAR(80) NULL,
    countryCode CHAR(2) NULL,
    region VARCHAR(80) NULL,
    city VARCHAR(80) NULL,
    timezone VARCHAR(64) NULL,
    languages VARCHAR(255) NULL,
    ministryRole VARCHAR(120) NULL,
    organization VARCHAR(150) NULL,
    contactConsent VARCHAR(12) NOT NULL DEFAULT 'unknown',
    consentSource VARCHAR(80) NULL,
    consentAt DATETIME NULL,
    summary TEXT NULL,
    summaryUpdatedAt DATETIME NULL,
    mbidCreatedAt DATETIME NULL,
    mbidRemovedAt DATETIME NULL,
    lastActiveAt DATETIME NULL,
    activitySyncedAt DATETIME NULL,
    updatedAt DATETIME NOT NULL,
    KEY idx_crmProfiles_church (churchId),
    KEY idx_crmProfiles_country (churchId, countryCode)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS crmNotes (
    id CHAR(11) NOT NULL PRIMARY KEY,
    churchId CHAR(11) NOT NULL,
    personId CHAR(11) NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'note',
    body MEDIUMTEXT NULL,
    images TEXT NULL,
    extracted MEDIUMTEXT NULL,
    addedBy CHAR(11) NULL,
    addedByName VARCHAR(100) NULL,
    createdAt DATETIME NOT NULL,
    KEY idx_crmNotes_person (churchId, personId, createdAt)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS crmFacts (
    id CHAR(11) NOT NULL PRIMARY KEY,
    churchId CHAR(11) NOT NULL,
    personId CHAR(11) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    text VARCHAR(1000) NOT NULL,
    noteId CHAR(11) NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'open',
    createdAt DATETIME NOT NULL,
    resolvedAt DATETIME NULL,
    KEY idx_crmFacts_person (churchId, personId, kind)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS crmTags (
    id CHAR(11) NOT NULL PRIMARY KEY,
    churchId CHAR(11) NOT NULL,
    name VARCHAR(60) NOT NULL,
    color VARCHAR(20) NULL,
    UNIQUE KEY uq_crmTags_name (churchId, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS crmPersonTags (
    churchId CHAR(11) NOT NULL,
    personId CHAR(11) NOT NULL,
    tagId CHAR(11) NOT NULL,
    createdAt DATETIME NOT NULL,
    PRIMARY KEY (churchId, personId, tagId),
    KEY idx_crmPersonTags_tag (churchId, tagId)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS crmActivities (
    id CHAR(11) NOT NULL PRIMARY KEY,
    churchId CHAR(11) NOT NULL,
    personId CHAR(11) NOT NULL,
    site VARCHAR(30) NOT NULL,
    type VARCHAR(40) NOT NULL,
    refKey VARCHAR(150) NOT NULL,
    title VARCHAR(300) NOT NULL,
    detail VARCHAR(500) NULL,
    url VARCHAR(500) NULL,
    occurredAt DATETIME NOT NULL,
    UNIQUE KEY uq_crmActivities (personId, site, type, refKey),
    KEY idx_crmActivities_person (churchId, personId, occurredAt)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS crmSyncState (
    name VARCHAR(64) NOT NULL PRIMARY KEY,
    value TEXT NULL,
    updatedAt DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS crmBotChecks (
    sub VARCHAR(64) NOT NULL PRIMARY KEY,
    bot TINYINT(1) NOT NULL,
    how VARCHAR(20) NOT NULL,
    checkedAt DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of ["crmBotChecks", "crmSyncState", "crmActivities", "crmPersonTags", "crmTags", "crmFacts", "crmNotes", "crmProfiles"]) {
    await sql.raw(`DROP TABLE IF EXISTS ${t}`).execute(db);
  }
  await sql`DROP INDEX idx_people_church_email ON people`.execute(db);
  await sql`DROP INDEX uq_people_church_mbidSub ON people`.execute(db);
  await sql`ALTER TABLE people DROP COLUMN mbidSub, DROP COLUMN source`.execute(db);
}
