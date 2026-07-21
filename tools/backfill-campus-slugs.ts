import "reflect-metadata";
import { Environment } from "../src/shared/helpers/Environment.js";
import { KyselyPool } from "../src/shared/infrastructure/KyselyPool.js";
import { RepoManager } from "../src/shared/infrastructure/index.js";
import { Repos } from "../src/modules/membership/repositories/index.js";
import { getDb } from "../src/modules/membership/db/index.js";

/**
 * One-time, IDEMPOTENT slug backfill (a DATA script, NOT a Kysely schema migration —
 * it does not participate in migration ordering). Fills the nullable `campuses.slug`
 * column that the 2026-07-23_campusSlug migration added.
 *
 * WHY THIS MATTERS: without it every downstream slug route stays a 404 because slugs
 * are null — the 20-04 Locations dropdown, 20-05 `/locations/[campusSlug]`, 20-06 map
 * "View campus", and the 20-04 sitemap all resolve a campus BY slug.
 *
 * For EVERY church, for every non-removed campus WHERE slug IS NULL, it computes a
 * slug from the display `name` and dedupes WITHIN the church (per `uq_campuses_slug`,
 * i.e. per `(churchId, slug)`). Existing (non-null) slugs are NEVER overwritten, so
 * re-running is a no-op.
 *
 * Run: tsx tools/backfill-campus-slugs.ts
 */

// slugify — lower-case, trim, collapse any run of non-alphanumerics to a single "-",
// strip leading/trailing "-". Defined inline (there is no shared slugify helper). An
// all-non-alphanumeric name collapses to "" — caller falls back to the campus id.
function slugify(input: string): string {
  return (input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function backfillCampusSlugs() {
  try {
    console.log("Initializing environment...");
    await Environment.init(process.env.ENVIRONMENT || "dev");

    const repos = await RepoManager.getRepos<Repos>("membership");
    const churches = await repos.church.loadAll();
    console.log(`Backfilling campus slugs for ${churches.length} church(es)...`);
    console.log("========================================");

    let grandTotal = 0;
    for (const church of churches) {
      const churchId = church.id;
      // All non-removed campuses for this church (ordered so assignment is deterministic).
      const campuses = (await repos.campus.loadAll(churchId)) as any[];

      // Seed the per-church taken-slug set with slugs that ALREADY exist (never clobber).
      const taken = new Set<string>();
      for (const c of campuses) {
        if (c.slug) taken.add(c.slug);
      }

      let assigned = 0;
      for (const campus of campuses) {
        if (campus.slug) continue; // already has a slug -> skip (idempotent)

        const base = slugify(campus.name) || String(campus.id); // empty name -> fall back to id
        let candidate = base;
        let n = 2;
        while (taken.has(candidate)) {
          candidate = `${base}-${n}`;
          n++;
        }
        taken.add(candidate);

        // Fill ONLY the null-slug row; WHERE slug IS NULL keeps a concurrent/re-run safe.
        await getDb().updateTable("campuses")
          .set({ slug: candidate })
          .where("id", "=", campus.id)
          .where("churchId", "=", churchId)
          .where("slug", "is", null as any)
          .execute();
        assigned++;
      }

      grandTotal += assigned;
      console.log(`Church ${church.name || churchId}: ${assigned} slug(s) assigned (${campuses.length} campus(es) total).`);
    }

    console.log("========================================");
    console.log(`Campus slug backfill completed: ${grandTotal} slug(s) assigned across ${churches.length} church(es).`);

    await KyselyPool.destroyAll();
    process.exit(0);
  } catch (error: any) {
    console.error("Campus slug backfill failed:", error);
    console.error("Stack trace:", error?.stack);
    process.exit(1);
  }
}

backfillCampusSlugs();
