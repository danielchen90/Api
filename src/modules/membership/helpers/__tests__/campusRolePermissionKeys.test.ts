import { CAMPUS_WRITE_PERMISSION, CAMPUS_ORGWIDE_MARKER } from "../campusRoles.js";

/**
 * REGRESSION (live-found 2026-06-30): the campus gate constants must match the church JWT's
 * UNPREFIXED permission strings.
 *
 * `AuthenticatedUser.checkAccess` (@churchapps/apihelper) builds its lookup key as
 *   key = permission.apiName ? `${apiName}_${contentType}__${action}` : `${contentType}__${action}`
 * and returns true iff that key is in the JWT's `permissions` array. The church JWT stores membership
 * permissions UNPREFIXED (`People__Edit`, `Campus__Admin` — see `buildPermStrings`, which prefixes
 * only when a stored permission carries `apiName`), AND a Domain-Admin owner's permissions are
 * replaced at login with the UNPREFIXED standard set. A constant carrying `apiName: "MembershipApi"`
 * builds `MembershipApi_People__Edit`, which never matches — so every campus-scoped write 401'd for
 * org-wide owners.
 *
 * `checkAccess` is replicated here verbatim from the upstream source (the real class is an
 * untransformed ESM value in node_modules and cannot be instantiated under jest's transform config;
 * the per-field mock in campusIsolation.test.ts never built the key, so it could not see the bug).
 */
function checkAccess(permissions: string[], permission: { apiName?: string; contentType: string; action: string }): boolean {
  const key = permission.apiName
    ? permission.apiName + "_" + permission.contentType + "__" + permission.action
    : permission.contentType + "__" + permission.action;
  return permissions.includes(key);
}

// Permission strings as they actually appear in a deployed church JWT (contentType__action, unprefixed).
const LEADERSHIP_ADMIN = ["People__Edit", "People__View", "Households__Edit", "Groups__View", "Groups__Edit", "Roles__View", "Campus__Admin"];
const DOMAIN_ADMIN_OWNER = ["People__Edit", "People__View", "Campus__Admin", "Groups__Edit", "Settings__Edit"]; // post replaceDomainAdminPermissions
const CAMPUS_ADMIN = ["People__Edit", "People__View", "Households__Edit", "Groups__View", "Groups__Edit", "Roles__View"]; // manage set, NO marker
const REPORTER = ["People__View", "Groups__View", "Campus__Admin"]; // view set + marker
const CAMPUS_VIEWER = ["People__View", "Groups__View"]; // view set only

describe("campus gate constants resolve against real JWT permission strings", () => {
  it("the constants are UNPREFIXED (no apiName) so checkAccess builds contentType__action", () => {
    expect((CAMPUS_WRITE_PERMISSION as { apiName?: string }).apiName).toBeUndefined();
    expect((CAMPUS_ORGWIDE_MARKER as { apiName?: string }).apiName).toBeUndefined();
  });

  it("Leadership Admin: write capability AND org-wide marker both granted", () => {
    expect(checkAccess(LEADERSHIP_ADMIN, CAMPUS_WRITE_PERMISSION)).toBe(true);
    expect(checkAccess(LEADERSHIP_ADMIN, CAMPUS_ORGWIDE_MARKER)).toBe(true);
  });

  it("Domain-Admin owner (perms replaced at login): write + marker both granted (the live 401 bug)", () => {
    expect(checkAccess(DOMAIN_ADMIN_OWNER, CAMPUS_WRITE_PERMISSION)).toBe(true);
    expect(checkAccess(DOMAIN_ADMIN_OWNER, CAMPUS_ORGWIDE_MARKER)).toBe(true);
  });

  it("Campus Admin: write capability but NOT the org-wide marker (campus-scoped writer)", () => {
    expect(checkAccess(CAMPUS_ADMIN, CAMPUS_WRITE_PERMISSION)).toBe(true);
    expect(checkAccess(CAMPUS_ADMIN, CAMPUS_ORGWIDE_MARKER)).toBe(false);
  });

  it("Reporter: org-wide marker but NO write capability (org-wide read-only)", () => {
    expect(checkAccess(REPORTER, CAMPUS_ORGWIDE_MARKER)).toBe(true);
    expect(checkAccess(REPORTER, CAMPUS_WRITE_PERMISSION)).toBe(false);
  });

  it("Campus Viewer: neither write capability nor marker", () => {
    expect(checkAccess(CAMPUS_VIEWER, CAMPUS_WRITE_PERMISSION)).toBe(false);
    expect(checkAccess(CAMPUS_VIEWER, CAMPUS_ORGWIDE_MARKER)).toBe(false);
  });
});
