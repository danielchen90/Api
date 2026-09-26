// Campus roles are seeded with apiName NULL, so at login their permissions land in an API bucket with
// no keyName. B1Admin calls /membership/* with the MembershipApi JWT, so the fold must copy them into
// the MembershipApi bucket (else org-wide admins resolve to campus scope "deny" and Campus Admins 401).
jest.mock("../index.js", () => ({ Environment: {}, permissionsList: [] }));
jest.mock("../../../../shared/helpers/TransactionalEmailSender.js", () => ({ TransactionalEmailSender: {} }));
jest.mock("@churchapps/apihelper", () => ({
  ArrayHelper: {
    getOne: (arr: any[], key: string, value: any) => (arr || []).find((x) => x?.[key] === value) ?? null,
    getAll: (arr: any[], key: string, value: any) => (arr || []).filter((x) => x?.[key] === value)
  }
}));

import { UserHelper } from "../UserHelper.js";

const perm = (contentType: string, action: string) => ({ contentType, action, contentId: null as any });

describe("UserHelper.foldUnscopedIntoMembership", () => {
  it("copies the unscoped campus-role permissions into MembershipApi without duplicates", () => {
    const luc: any = {
      apis: [
        { keyName: null, permissions: [perm("Campus", "Admin"), perm("People", "Edit"), perm("Groups", "View")] },
        { keyName: "MembershipApi", permissions: [perm("People", "Edit"), perm("Forms", "Admin")] },
        { keyName: "ContentApi", permissions: [perm("Content", "Edit")] }
      ]
    };
    UserHelper.foldUnscopedIntoMembership(luc);
    const m = luc.apis.find((a: any) => a.keyName === "MembershipApi");
    const keys = m.permissions.map((p: any) => p.contentType + "__" + p.action).sort();
    expect(keys).toEqual(["Campus__Admin", "Forms__Admin", "Groups__View", "People__Edit"]);
    // other buckets untouched, unscoped bucket kept
    expect(luc.apis.find((a: any) => a.keyName === "ContentApi").permissions).toHaveLength(1);
    expect(luc.apis.find((a: any) => a.keyName === null).permissions).toHaveLength(3);
  });

  it("creates the MembershipApi bucket for a Campus Admin who has no other membership permission", () => {
    const luc: any = { apis: [{ keyName: null, permissions: [perm("People", "Edit")] }] };
    UserHelper.syncCrossModulePermissions([luc]);
    const m = luc.apis.find((a: any) => a.keyName === "MembershipApi");
    expect(m.permissions.map((p: any) => p.contentType)).toContain("People");
  });

  it("is a no-op when there is no unscoped bucket", () => {
    const luc: any = { apis: [{ keyName: "MembershipApi", permissions: [perm("People", "View")] }] };
    UserHelper.foldUnscopedIntoMembership(luc);
    expect(luc.apis).toHaveLength(1);
    expect(luc.apis[0].permissions).toHaveLength(1);
  });
});
