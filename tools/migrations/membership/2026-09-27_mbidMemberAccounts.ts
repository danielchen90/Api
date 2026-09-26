import { type Kysely, sql } from "kysely";

// Mary Banks ID sign-in + verified extra emails (members round, 2026-09).
//
//   users.mbidSub           the Mary Banks ID (Keycloak) `sub` this ChurchApps user is linked to.
//                           UNIQUE (MySQL allows many NULLs), so one Mary Banks ID maps to at most
//                           one user. NULL for every existing user until they sign in that way.
//   emailVerificationCodes  six-digit codes that prove an extra email address. Only a hash is
//                           stored (HMAC-SHA256 keyed with ENCRYPTION_KEY over a per-row salt), with
//                           an expiry, an attempt counter and a consumed marker. Rows are small and
//                           short-lived; the send limit counts rows per user in the last hour.
//
// Hand-dated 2026-09-27: strictly after the last membership migration (2026-09-26_formSubmissionExtra).
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE users ADD COLUMN mbidSub VARCHAR(64) NULL`.execute(db);
  await sql`CREATE UNIQUE INDEX uq_users_mbidSub ON users (mbidSub)`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS emailVerificationCodes (
    id CHAR(11) NOT NULL PRIMARY KEY,
    userId CHAR(11) NOT NULL,
    email VARCHAR(191) NOT NULL,
    codeHash CHAR(64) NOT NULL,
    salt CHAR(32) NOT NULL,
    attempts TINYINT NOT NULL DEFAULT 0,
    expiresAt DATETIME NOT NULL,
    consumedAt DATETIME NULL,
    createdAt DATETIME NOT NULL,
    KEY idx_emailVerificationCodes_user (userId, createdAt)
  ) ENGINE=InnoDB`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS emailVerificationCodes`.execute(db);
  await sql`DROP INDEX uq_users_mbidSub ON users`.execute(db);
  await sql`ALTER TABLE users DROP COLUMN mbidSub`.execute(db);
}
