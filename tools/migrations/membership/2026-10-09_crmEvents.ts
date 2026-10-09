import { type Kysely, sql } from "kysely";

// The CRM event planner (2026-10): Bible studies, conferences, fast tracks, services.
//
//   crmEvents               one event: its message and topics, speakers, start/end as UTC instants
//                           plus the host's time zone, the public landing page copy (AI-drafted,
//                           staff-edited, JSON), the registration form's extra questions (JSON),
//                           the flyer, and the join link (shown only to people who registered).
//   crmEventRegistrations   one sign-up, tied to a church person (found or created as a CRM
//                           contact). Unique per (event, email).
//   crmEventEmails          the event's emails: confirmation, reminders before the start, a
//                           follow-up after the end, and one-off invitations/updates.
//   crmEventEmailSends      one row per (email, recipient) actually sent: the scheduler's
//                           exactly-once guard.
//
// Hand-dated 2026-10-09: strictly after 2026-10-08_crm.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS crmEvents (
    id CHAR(11) NOT NULL PRIMARY KEY,
    churchId CHAR(11) NOT NULL,
    slug VARCHAR(80) NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'study',
    status VARCHAR(12) NOT NULL DEFAULT 'draft',
    title VARCHAR(200) NOT NULL,
    subtitle VARCHAR(300) NULL,
    message MEDIUMTEXT NULL,
    topics TEXT NULL,
    speakers TEXT NULL,
    startsAt DATETIME NULL,
    endsAt DATETIME NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'America/New_York',
    schedule VARCHAR(300) NULL,
    location VARCHAR(300) NULL,
    joinUrl VARCHAR(500) NULL,
    languages VARCHAR(255) NULL,
    capacity INT NULL,
    registrationOpen TINYINT(1) NOT NULL DEFAULT 1,
    page MEDIUMTEXT NULL,
    questions TEXT NULL,
    flyerUrl VARCHAR(500) NULL,
    imageUrl VARCHAR(500) NULL,
    tagId CHAR(11) NULL,
    createdBy CHAR(11) NULL,
    createdAt DATETIME NOT NULL,
    updatedAt DATETIME NOT NULL,
    UNIQUE KEY uq_crmEvents_slug (churchId, slug),
    KEY idx_crmEvents_start (churchId, startsAt)
  ) ENGINE=InnoDB`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS crmEventRegistrations (
    id CHAR(11) NOT NULL PRIMARY KEY,
    churchId CHAR(11) NOT NULL,
    eventId CHAR(11) NOT NULL,
    personId CHAR(11) NULL,
    firstName VARCHAR(50) NULL,
    lastName VARCHAR(50) NULL,
    email VARCHAR(191) NOT NULL,
    phone VARCHAR(40) NULL,
    countryCode CHAR(2) NULL,
    city VARCHAR(80) NULL,
    timezone VARCHAR(64) NULL,
    language VARCHAR(40) NULL,
    ministryRole VARCHAR(120) NULL,
    organization VARCHAR(150) NULL,
    groupSize INT NULL,
    answers TEXT NULL,
    contactConsent TINYINT(1) NOT NULL DEFAULT 0,
    status VARCHAR(12) NOT NULL DEFAULT 'registered',
    source VARCHAR(30) NULL,
    createdAt DATETIME NOT NULL,
    UNIQUE KEY uq_crmEventRegistrations (eventId, email),
    KEY idx_crmEventRegistrations_person (churchId, personId)
  ) ENGINE=InnoDB`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS crmEventEmails (
    id CHAR(11) NOT NULL PRIMARY KEY,
    churchId CHAR(11) NOT NULL,
    eventId CHAR(11) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    offsetMinutes INT NULL,
    audience TEXT NULL,
    subject VARCHAR(300) NOT NULL,
    body MEDIUMTEXT NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    sendAt DATETIME NULL,
    sentAt DATETIME NULL,
    sentCount INT NOT NULL DEFAULT 0,
    createdAt DATETIME NOT NULL,
    updatedAt DATETIME NOT NULL,
    KEY idx_crmEventEmails_event (churchId, eventId)
  ) ENGINE=InnoDB`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS crmEventEmailSends (
    emailId CHAR(11) NOT NULL,
    recipientKey VARCHAR(191) NOT NULL,
    churchId CHAR(11) NOT NULL,
    status VARCHAR(12) NOT NULL,
    error VARCHAR(300) NULL,
    sentAt DATETIME NOT NULL,
    PRIMARY KEY (emailId, recipientKey)
  ) ENGINE=InnoDB`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of ["crmEventEmailSends", "crmEventEmails", "crmEventRegistrations", "crmEvents"]) await sql.raw(`DROP TABLE IF EXISTS ${t}`).execute(db);
}
