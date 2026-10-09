// Run the event-email tick as if it were a given time: tsx tools/crm/tick-at.ts 2026-11-13T00:05:00Z
import "reflect-metadata";
import dotenv from "dotenv";
dotenv.config();
const { Environment } = await import("../../src/shared/helpers/Environment.js");
await Environment.init(process.env.ENVIRONMENT || "dev");
const { RepoManager } = await import("../../src/shared/infrastructure/RepoManager.js");
const { CrmEventMailer } = await import("../../src/modules/membership/helpers/crm/CrmEventMailer.js");
const repos = await RepoManager.getRepos<any>("membership");
for (const at of process.argv.slice(2)) console.log(at, JSON.stringify(await CrmEventMailer.tick(repos, new Date(at))));
process.exit(0);
