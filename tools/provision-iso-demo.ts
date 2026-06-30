import "reflect-metadata";
import bcrypt from "bcryptjs";
import { Environment } from "../src/shared/helpers/Environment.js";
import { KyselyPool } from "../src/shared/infrastructure/KyselyPool.js";
import { RepoManager } from "../src/shared/infrastructure/index.js";
import { Repos } from "../src/modules/membership/repositories/index.js";
import { CAMPUS_ADMIN_ROLE } from "../src/modules/membership/helpers/campusRoles.js";

/**
 * ONE-OFF demo fixture (NOT a schema migration). Provisions a campus-scoped test user to demonstrate
 * cross-campus isolation live (PERM-07 / ORD scope). Idempotent on the keyed entities (campuses by
 * name, user by email, role membership, userCampus assignment).
 *
 *   - Campus A + Campus B (church-scoped)
 *   - an ACTIVE ordination living in Campus B (on the church's first person)
 *   - a login user (CAMPUS_ADMIN_EMAIL) who is a Campus Admin (manage set, NO org-wide marker)
 *     assigned via userCampus to Campus A ONLY
 *
 * Expected live result: that user can read/write Campus A, but is 404-hidden / 401-denied for the
 * Campus B ordination, and 401 on ordinationTypes (no org-wide marker).
 *
 * Run: tsx tools/provision-iso-demo.ts
 */

const CAMPUS_ADMIN_EMAIL = "iso-campusadmin@btii.test";
const CAMPUS_ADMIN_PASSWORD = "ISOdemo123!";
const CAMPUS_A_NAME = "ISO Demo Campus A";
const CAMPUS_B_NAME = "ISO Demo Campus B";

async function findOrCreateCampus(repos: Repos, churchId: string, name: string) {
  const all = await repos.campus.loadAll(churchId);
  return all.find((c: any) => c.name === name) ?? (await repos.campus.save({ churchId, name } as any));
}

async function main() {
  await Environment.init(process.env.ENVIRONMENT || "dev");
  const repos = await RepoManager.getRepos<Repos>("membership");

  const church = (await repos.church.loadAll())[0];
  const churchId = church.id;

  // 1. Two campuses
  const campusA = await findOrCreateCampus(repos, churchId, CAMPUS_A_NAME);
  const campusB = await findOrCreateCampus(repos, churchId, CAMPUS_B_NAME);

  // 2. A minister (reuse the church's first existing person) + an active ordination in CAMPUS B
  const minister = (await repos.person.loadAll(churchId))[0];
  const types = await repos.ordinationType.loadActive(churchId);
  const typeId = types[0].id;
  const existingB = (await repos.personOrdination.loadForPerson(churchId, minister.id, { mode: "all" }))
    .find((o: any) => o.campusId === campusB.id && o.status === "active");
  let ordB = existingB;
  if (!ordB) {
    ordB = await repos.personOrdination.save({
      churchId, personId: minister.id, ordinationTypeId: typeId, campusId: campusB.id,
      status: "active", credentialNumber: "ISO-B-001", createdBy: "provision-script"
    } as any);
  }

  // 3. Campus Admin login user
  let user = await repos.user.loadByEmail(CAMPUS_ADMIN_EMAIL);
  if (!user) {
    user = await repos.user.save({
      email: CAMPUS_ADMIN_EMAIL, password: bcrypt.hashSync(CAMPUS_ADMIN_PASSWORD, 10),
      firstName: "ISO", lastName: "CampusAdmin", registrationDate: new Date()
    } as any);
  }

  // 4. Person + userChurch so login resolves a church
  let uc = await repos.userChurch.loadByUserId(user.id, churchId);
  if (!uc) {
    const adminPerson = await repos.person.save({ churchId, name: { first: "ISO", last: "CampusAdmin" }, contactInfo: { email: CAMPUS_ADMIN_EMAIL } } as any);
    uc = await repos.userChurch.save({ userId: user.id, churchId, personId: adminPerson.id } as any);
  }

  // 5. Add to the Campus Admin role (manage set, NO org-wide marker)
  const roles = await repos.role.loadByChurchId(churchId);
  const campusAdminRole = roles.find((r: any) => r.name === CAMPUS_ADMIN_ROLE);
  const members = await repos.roleMember.loadByRoleId(campusAdminRole.id, churchId);
  if (!members.some((m: any) => m.userId === user.id)) {
    await repos.roleMember.save({ churchId, roleId: campusAdminRole.id, userId: user.id, addedBy: user.id } as any);
  }

  // 6. Assign userCampus → Campus A ONLY
  const assignments = await repos.userCampus.loadForUser(churchId, user.id);
  if (!assignments.some((a: any) => a.campusId === campusA.id)) {
    await repos.userCampus.save({ churchId, userId: user.id, campusId: campusA.id, addedBy: user.id } as any);
  }

  console.log("PROVISION_RESULT " + JSON.stringify({
    churchId, email: CAMPUS_ADMIN_EMAIL, password: CAMPUS_ADMIN_PASSWORD,
    campusA: campusA.id, campusB: campusB.id,
    ministerPersonId: minister.id, ordinationInCampusB: ordB.id, ordinationTypeId: typeId
  }));

  await KyselyPool.destroyAll();
  process.exit(0);
}

main().catch((e) => { console.error("PROVISION_FAILED", e?.stack || e); process.exit(1); });
