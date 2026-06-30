import { ApiName, Actions } from "../../../shared/helpers/index.js";

/**
 * Campus role descriptors + the two linchpin permission constants.
 *
 * SINGLE SOURCE OF TRUTH for:
 *   - CAMPUS_ORGWIDE_MARKER  — the org-wide scope marker (consumed by Plan 02's CampusScopeHelper.resolve)
 *   - CAMPUS_WRITE_PERMISSION — the Edit-bearing write-capability gate (consumed by Plan 04's UserCampusController write gate)
 *   - CAMPUS_ROLE_DESCRIPTORS — the four campus roles and their rolePermissions sets (seeded by tools/seed-campus-roles.ts)
 *
 * This module is net-new and deliberately does NOT touch src/shared/helpers/Permissions.ts or
 * `permissionsList` (Phase 3 owns those).
 */

/**
 * Permission shape mirroring the standard `Permissions` constants ({ contentType, action }).
 *
 * CRITICAL — NO `apiName` (see CAMPUS_*_PERMISSION below): `AuthenticatedUser.checkAccess` builds its
 * lookup key as `apiName + "_" + contentType + "__" + action` ONLY when `apiName` is present, else
 * `contentType + "__" + action`. The church JWT stores membership permissions UNPREFIXED
 * (`People__Edit`, `Campus__Admin` — see `buildPermStrings`, which prefixes only when a stored
 * permission carries `apiName`). A constant with `apiName` would build `MembershipApi_People__Edit`
 * and never match — so these MUST be unprefixed, exactly like `Permissions.people.edit`. `apiName`
 * is kept OPTIONAL only so the union/imports stay available; it is deliberately left unset.
 *
 * `contentType` is intentionally typed `string` rather than the `ContentType` union: the org-wide
 * marker's contentType ("Campus") MUST NOT be a member of the union / `permissionsList` (Pitfall 1:
 * `UserHelper.replaceDomainAdminPermissions()` strips or auto-injects anything in `permissionsList`
 * at login expansion, which would silently destroy the marker).
 */
export interface CampusRolePermission {
  apiName?: ApiName;
  contentType: string;
  action: Actions;
}

/**
 * Org-wide marker permission (JWT perm string `Campus__Admin` — UNPREFIXED, see CampusRolePermission).
 *
 * The SINGLE source of truth consumed by Plan 02's resolver to return `mode:"all"` for org-wide roles.
 * `Campus__Admin` is also the standard Campus-Admin permission a Domain Admin holds after
 * `replaceDomainAdminPermissions` (which injects the UNPREFIXED standard set), so org-wide owners
 * resolve to `mode:"all"` as intended.
 *
 * CRITICAL (Pitfall 1): this contentType/action MUST NOT appear in `permissionsList`, so
 * `UserHelper.replaceDomainAdminPermissions()` never strips or auto-injects it.
 */
export const CAMPUS_ORGWIDE_MARKER = { contentType: "Campus", action: "Admin" } as const satisfies CampusRolePermission;

/**
 * Edit-bearing write-capability permission (JWT perm string `People__Edit` — UNPREFIXED).
 *
 * The SINGLE source of truth consumed by Plan 04's `UserCampusController` write gate via
 * `au.checkAccess(CAMPUS_WRITE_PERMISSION)`. It is granted ONLY to Leadership Admin + Campus Admin
 * (the two writer roles) and is deliberately NOT the org-wide marker — Reporter holds the marker but
 * is read-only (Plan 05 Open-Q3: scope `all` does not imply write capability). It mirrors
 * `Permissions.people.edit`, an existing entry in the manage set / `permissionsList`, so seeding it
 * requires no changes to `permissionsList`.
 */
export const CAMPUS_WRITE_PERMISSION = { contentType: "People", action: "Edit" } as const satisfies CampusRolePermission;

// Read permissions (granted to every campus role). UNPREFIXED to match the JWT (see CampusRolePermission).
const PEOPLE_VIEW = { contentType: "People", action: "View" } as const satisfies CampusRolePermission;
const GROUPS_VIEW = { contentType: "Groups", action: "View" } as const satisfies CampusRolePermission;

// Additional write/manage permissions (granted only to the two writer roles, alongside CAMPUS_WRITE_PERMISSION).
const HOUSEHOLDS_EDIT = { contentType: "Households", action: "Edit" } as const satisfies CampusRolePermission;
const GROUPS_EDIT = { contentType: "Groups", action: "Edit" } as const satisfies CampusRolePermission;
const ROLES_VIEW = { contentType: "Roles", action: "View" } as const satisfies CampusRolePermission;

/**
 * The full manage set (mirrors the commented Domain Admins set in RoleHelper). The People-Edit entry
 * IS the exact `CAMPUS_WRITE_PERMISSION` object (referenced, not retyped) so the grant and Plan 04's
 * write gate are the same permission and cannot drift.
 */
const MANAGE_SET: CampusRolePermission[] = [PEOPLE_VIEW, CAMPUS_WRITE_PERMISSION, HOUSEHOLDS_EDIT, GROUPS_VIEW, GROUPS_EDIT, ROLES_VIEW];

// Read-only set (only *__View permissions; no Edit → mutation endpoints 401 via checkAccess).
const VIEW_SET: CampusRolePermission[] = [PEOPLE_VIEW, GROUPS_VIEW];

// Role names (mapped onto the existing ChurchApps `roles` table — no parallel role system).
export const LEADERSHIP_ADMIN_ROLE = "Leadership Admin";
export const CAMPUS_ADMIN_ROLE = "Campus Admin";
export const CAMPUS_VIEWER_ROLE = "Campus Viewer";
export const REPORTER_ROLE = "Reporter";

export interface CampusRoleDescriptor {
  name: string;
  permissions: CampusRolePermission[];
}

/**
 * The four campus roles (PERM-03/04/05). Per RESEARCH "Role Mapping":
 *   - Leadership Admin: manage set + marker  → cross-campus writer (mode:"all")
 *   - Campus Admin:     manage set, no marker → campus-scoped writer (mode:"scoped")
 *   - Campus Viewer:    view set,   no marker → campus-scoped read-only
 *   - Reporter:         view set  + marker    → org-wide read-only
 */
export const CAMPUS_ROLE_DESCRIPTORS: CampusRoleDescriptor[] = [
  { name: LEADERSHIP_ADMIN_ROLE, permissions: [...MANAGE_SET, CAMPUS_ORGWIDE_MARKER] },
  { name: CAMPUS_ADMIN_ROLE, permissions: [...MANAGE_SET] },
  { name: CAMPUS_VIEWER_ROLE, permissions: [...VIEW_SET] },
  { name: REPORTER_ROLE, permissions: [...VIEW_SET, CAMPUS_ORGWIDE_MARKER] }
];
