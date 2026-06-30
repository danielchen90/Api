import "reflect-metadata";
import { Environment } from "../src/shared/helpers/Environment.js";
import { KyselyPool } from "../src/shared/infrastructure/KyselyPool.js";
import { RepoManager } from "../src/shared/infrastructure/index.js";
import { Repos } from "../src/modules/membership/repositories/index.js";
import { Role, RoleMember, RolePermission } from "../src/modules/membership/models/index.js";
import {
  CAMPUS_ROLE_DESCRIPTORS,
  CampusRolePermission,
  LEADERSHIP_ADMIN_ROLE
} from "../src/modules/membership/helpers/campusRoles.js";

const DOMAIN_ADMINS_ROLE = "Domain Admins";

/**
 * One-time, idempotent DATA seed (not a schema migration). Maps the four campus roles onto the
 * existing ChurchApps RBAC tables (roles / rolePermissions / roleMembers) for every church, and
 * promotes each church's existing owner(s) — the members of "Domain Admins" — to "Leadership Admin".
 *
 * Re-running is a no-op: roles are resolved by name, permissions are reconciled by (apiName,
 * contentType, action), and members are added only when missing.
 *
 * Run: tsx tools/seed-campus-roles.ts
 */

// RoleRepo exposes no name-lookup — match in-memory on the church's loaded role list.
function findRoleByName(roles: Role[], name: string): Role | undefined {
  return roles.find((r) => r.name === name);
}

function permissionExists(existing: RolePermission[], p: CampusRolePermission): boolean {
  return existing.some((e) => e.apiName === p.apiName && e.contentType === p.contentType && e.action === p.action);
}

async function ensureRoleWithPermissions(repos: Repos, churchId: string, churchRoles: Role[], descriptorName: string, permissions: CampusRolePermission[]) {
  let role = findRoleByName(churchRoles, descriptorName);
  let created = false;
  if (!role) {
    role = await repos.role.save({ churchId, name: descriptorName });
    churchRoles.push(role); // keep the in-memory list current for later lookups (e.g. Leadership Admin)
    created = true;
  }

  const existing = await repos.rolePermission.loadByRoleId(churchId, role.id);
  let permsAdded = 0;
  for (const p of permissions) {
    if (permissionExists(existing, p)) continue;
    const rp = new RolePermission({
      churchId,
      roleId: role.id,
      apiName: p.apiName,
      contentType: p.contentType as RolePermission["contentType"],
      action: p.action
    });
    await repos.rolePermission.save(rp);
    permsAdded++;
  }

  return { role, created, permsAdded };
}

async function promoteOwners(repos: Repos, churchId: string, churchRoles: Role[]): Promise<number> {
  const domainAdmins = findRoleByName(churchRoles, DOMAIN_ADMINS_ROLE);
  const leadershipAdmin = findRoleByName(churchRoles, LEADERSHIP_ADMIN_ROLE);
  if (!domainAdmins || !leadershipAdmin) return 0;

  // NOTE: arg order differs from RolePermissionRepo.loadByRoleId — RoleMemberRepo is (roleId, churchId).
  const owners = await repos.roleMember.loadByRoleId(domainAdmins.id, churchId);
  const currentLeadership = await repos.roleMember.loadByRoleId(leadershipAdmin.id, churchId);
  const existingUserIds = new Set(currentLeadership.map((m) => m.userId));

  let promoted = 0;
  for (const owner of owners) {
    if (!owner.userId || existingUserIds.has(owner.userId)) continue;
    const member: RoleMember = { churchId, roleId: leadershipAdmin.id, userId: owner.userId, addedBy: owner.userId };
    await repos.roleMember.save(member);
    existingUserIds.add(owner.userId);
    promoted++;
  }
  return promoted;
}

async function seedCampusRoles() {
  try {
    console.log("Initializing environment...");
    await Environment.init(process.env.ENVIRONMENT || "dev");

    const repos = await RepoManager.getRepos<Repos>("membership");
    const churches = await repos.church.loadAll();
    console.log(`Seeding campus roles for ${churches.length} church(es)...`);
    console.log("========================================");

    for (const church of churches) {
      const churchId = church.id;
      const churchRoles: Role[] = await repos.role.loadByChurchId(churchId);

      let rolesCreated = 0;
      let permsAdded = 0;
      for (const descriptor of CAMPUS_ROLE_DESCRIPTORS) {
        const result = await ensureRoleWithPermissions(repos, churchId, churchRoles, descriptor.name, descriptor.permissions);
        if (result.created) rolesCreated++;
        permsAdded += result.permsAdded;
      }

      const promoted = await promoteOwners(repos, churchId, churchRoles);

      console.log(`Church ${church.name || churchId}: ${rolesCreated} role(s) created, ${permsAdded} permission(s) added, ${promoted} owner(s) promoted to Leadership Admin.`);
    }

    console.log("========================================");
    console.log("Campus role seed completed successfully!");

    await KyselyPool.destroyAll();
    process.exit(0);
  } catch (error: any) {
    console.error("Campus role seed failed:", error);
    console.error("Stack trace:", error?.stack);
    process.exit(1);
  }
}

seedCampusRoles();
