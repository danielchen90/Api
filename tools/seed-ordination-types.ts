import "reflect-metadata";
import { Environment } from "../src/shared/helpers/Environment.js";
import { KyselyPool } from "../src/shared/infrastructure/KyselyPool.js";
import { RepoManager } from "../src/shared/infrastructure/index.js";
import { Repos } from "../src/modules/membership/repositories/index.js";
import { STARTER_ORDINATION_TYPES } from "../src/modules/membership/helpers/ordinationTypes.js";

/**
 * One-time, idempotent DATA seed (not a schema migration). Gives every existing church the starter
 * ordination vocabulary (Bishop, Pastor, Elder, Minister, Evangelist, Deacon) sourced from
 * STARTER_ORDINATION_TYPES — the SINGLE source of truth (02-01), never redeclared here.
 *
 * Re-running is a no-op: each (churchId, code) is probed via repos.ordinationType.loadByCode and a
 * row is inserted ONLY when missing. A second run inserts zero rows. Mirrors tools/seed-campus-roles.ts.
 *
 * Run: tsx tools/seed-ordination-types.ts
 */
async function seedOrdinationTypes() {
  try {
    console.log("Initializing environment...");
    await Environment.init(process.env.ENVIRONMENT || "dev");

    const repos = await RepoManager.getRepos<Repos>("membership");
    const churches = await repos.church.loadAll();
    console.log(`Seeding ordination types for ${churches.length} church(es)...`);
    console.log("========================================");

    for (const church of churches) {
      const churchId = church.id;

      let inserted = 0;
      let skipped = 0;
      for (const type of STARTER_ORDINATION_TYPES) {
        const existing = await repos.ordinationType.loadByCode(churchId, type.code);
        if (existing) {
          skipped++;
          continue;
        }
        await repos.ordinationType.save({
          churchId,
          name: type.name,
          code: type.code,
          sortOrder: type.sortOrder,
          active: true
        });
        inserted++;
      }

      console.log(`Church ${church.name || churchId}: ${inserted} type(s) inserted, ${skipped} already present.`);
    }

    console.log("========================================");
    console.log("Ordination type seed completed successfully!");

    await KyselyPool.destroyAll();
    process.exit(0);
  } catch (error: any) {
    console.error("Ordination type seed failed:", error);
    console.error("Stack trace:", error?.stack);
    process.exit(1);
  }
}

seedOrdinationTypes();
