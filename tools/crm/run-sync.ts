// Run the CRM syncs once from the command line: tsx tools/crm/run-sync.ts [keycloak|activity|all] [--full]
import "reflect-metadata";import dotenv from "dotenv";
dotenv.config();
const { Environment } = await import("../../src/shared/helpers/Environment.js");
await Environment.init(process.env.ENVIRONMENT || "dev");
const { RepoManager } = await import("../../src/shared/infrastructure/RepoManager.js");
const { CrmSyncService } = await import("../../src/modules/membership/helpers/crm/CrmSyncService.js");
const { CrmActivitySync } = await import("../../src/modules/membership/helpers/crm/CrmActivitySync.js");
const what = process.argv[2] || "all";
const repos = await RepoManager.getRepos<any>("membership");
if (what === "all" || what === "keycloak") console.log("keycloak", await new CrmSyncService(repos).run());
if (what === "all" || what === "activity") console.log("activity", JSON.stringify(await new CrmActivitySync(repos).run({ full: process.argv.includes("--full") }), null, 1));
process.exit(0);
