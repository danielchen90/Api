import "reflect-metadata";
import { Environment } from "../src/shared/helpers/Environment.js";
import { KyselyPool } from "../src/shared/infrastructure/KyselyPool.js";
import { RepoManager } from "../src/shared/infrastructure/index.js";
import { Repos } from "../src/modules/membership/repositories/index.js";
import { getDb } from "../src/modules/membership/db/index.js";

/**
 * Removes every fixture created by tools/provision-iso-demo.ts and the live demo runs:
 *   - the iso-campusadmin@btii.test user + its person + userChurch + roleMember + userCampus
 *   - the "ISO Demo Campus A/B" campuses
 *   - all demo ordinations (credentialNumber LIKE 'ISO-%' or 'VERIFY-%')
 * Hard-deletes so no demo rows linger in production. Idempotent.
 *
 * Run: tsx tools/cleanup-iso-demo.ts
 */

const EMAIL = "iso-campusadmin@btii.test";

async function main() {
  await Environment.init(process.env.ENVIRONMENT || "dev");
  const repos = await RepoManager.getRepos<Repos>("membership");
  const db = getDb();
  const churchId = (await repos.church.loadAll())[0].id;
  const report: Record<string, number> = {};

  // 1. demo ordinations (both the ISO-* and the earlier VERIFY-* live-test rows)
  const ords = await db.deleteFrom("personOrdinations")
    .where("churchId", "=", churchId)
    .where((eb) => eb.or([eb("credentialNumber", "like", "ISO-%"), eb("credentialNumber", "like", "VERIFY-%")]))
    .executeTakeFirst();
  report.ordinations = Number(ords.numDeletedRows ?? 0n);

  // 2. demo campuses by name
  const campuses = await db.deleteFrom("campuses")
    .where("churchId", "=", churchId)
    .where("name", "in", ["ISO Demo Campus A", "ISO Demo Campus B"])
    .executeTakeFirst();
  report.campuses = Number(campuses.numDeletedRows ?? 0n);

  // 3. the test user and everything hanging off it
  const user = await repos.user.loadByEmail(EMAIL);
  if (user) {
    const uc = await repos.userChurch.loadByUserId(user.id, churchId);
    await db.deleteFrom("userCampuses").where("churchId", "=", churchId).where("userId", "=", user.id).execute();
    await db.deleteFrom("roleMembers").where("churchId", "=", churchId).where("userId", "=", user.id).execute();
    await db.deleteFrom("userChurches").where("userId", "=", user.id).execute();
    if (uc?.personId) await db.deleteFrom("people").where("churchId", "=", churchId).where("id", "=", uc.personId).execute();
    await db.deleteFrom("users").where("id", "=", user.id).execute();
    report.userRemoved = 1;
  } else {
    report.userRemoved = 0;
  }

  console.log("CLEANUP_RESULT " + JSON.stringify(report));
  await KyselyPool.destroyAll();
  process.exit(0);
}

main().catch((e) => { console.error("CLEANUP_FAILED", e?.stack || e); process.exit(1); });
