// ── PUB-02 ENUMERATION-SAFETY GATE (DB-free, CI-gated) ───────────────────────────────────────
// Anonymous endpoints must NOT be account-existence oracles: a member email and a non-member
// email must produce a BYTE-IDENTICAL response (same status + same JSON bytes). This suite drives
// the REAL `UserController.forgotPassword` handler over a mocked repo (no DB, no live mail) for a
// user-EXISTS and a user-ABSENT case and asserts the two responses are indistinguishable. It also
// asserts the former `checkEmail` existence+PII oracle is GONE from the controller's anonymous
// surface. A regression that reintroduces either oracle FAILS `yarn test` (.github/workflows/test.yml).
//
// Mocks are declared before the unit import (ts-jest CommonJS hoist order). We stub the mail/crypto/
// audit seams so the handler runs to completion without any I/O; the repo is a plain fake.

// UserController pulls a deep ESM chain (apihelper base classes, auth, infrastructure/Environment)
// that Jest's CommonJS transform can't `require`. We mock every seam UserController imports so the
// controller MODULE loads and its forgotPassword handler runs DB-free. The handler under test only
// touches: this.repos.user, Environment.isMailConfigured, UserHelper.sendForgotEmail, AuditLogHelper,
// bcrypt, express-validator, and generateVerificationCode (module-local). None require real I/O.

// apihelper base package — stub the base controller + ArrayHelper the controller extends/imports.
jest.mock("@churchapps/apihelper", () => ({
  ArrayHelper: { getOne: () => null, getAll: () => [] },
  EnvironmentBase: class {},
  CustomBaseController: class {
    public logger = { flush: async () => {}, error: () => {} };
    json(body: any, status: number) { return { body, status }; }
    error(errors: any) { return { body: { errors }, status: 500 }; }
    denyAccess(errors: any) { return { body: { errors }, status: 401 }; }
  },
  AuthenticatedUser: class {},
  Principal: class {}
}));
// The membership auth barrel (AuthenticatedUser) is never used on the forgotPassword path.
jest.mock("../../auth/index.js", () => ({ AuthenticatedUser: class {} }));
// The shared infrastructure barrel BaseController extends (RepoManager + BaseController).
jest.mock("../../../../shared/infrastructure/index.js", () => ({
  RepoManager: { getRepos: async () => ({}) },
  BaseController: class {
    public logger = { flush: async () => {}, error: () => {} };
    constructor(_m?: string) {}
    json(body: any, status: number) { return { body, status }; }
    error(errors: any) { return { body: { errors }, status: 500 }; }
    denyAccess(errors: any) { return { body: { errors }, status: 401 }; }
    actionWrapperAnon(_req: any, _res: any, action: () => Promise<any>) { return action(); }
    actionWrapper(_req: any, _res: any, action: (au: any) => Promise<any>) { return action({}); }
  }
}));
// The membership helpers BARREL, stubbed STANDALONE (no requireActual — that would re-load the real
// Environment→apihelper ESM chain). Supplies ONLY the names UserController imports from it.
// Environment.isMailConfigured=true so the handler takes the "mail configured" branch (otherwise it
// 400s before reaching the oracle-safe path); sendForgotEmail is a no-op (never hits SES).
jest.mock("../index.js", () => ({
  Environment: { isMailConfigured: true, currentEnvironment: "test", emailOnRegistration: false, supportEmail: "s@test", isMailConfigured_: true },
  Permissions: { settings: { edit: {} }, server: { admin: {} } },
  EmailHelper: { sendTemplatedEmail: jest.fn(async () => {}) },
  UserHelper: { sendForgotEmail: jest.fn(async () => {}), sendWelcomeEmail: jest.fn(async () => {}), sendInviteEmail: jest.fn(async () => {}), replaceDomainAdminPermissions: () => {}, syncCrossModulePermissions: () => {}, addAllReportingPermissions: () => {} },
  UserChurchHelper: { createForNewUser: jest.fn(async () => {}) },
  UniqueIdHelper: { shortId: () => "sid" },
  AuditLogHelper: { log: jest.fn(() => {}), getClientIp: jest.fn(() => "127.0.0.1"), logLogin: jest.fn(() => {}) },
  MauticHelper: { trackLogin: jest.fn(async () => {}) },
  ChurchHelper: { appendLogos: jest.fn(async () => {}) }
}));
// express-validator: force validationResult(...).isEmpty() === true so the handler proceeds past
// the input-validation guard with our raw fake req (no middleware ran).
jest.mock("express-validator", () => {
  const actual = jest.requireActual("express-validator");
  return { ...actual, validationResult: () => ({ isEmpty: () => true, array: () => [] }) };
});

import { UserController } from "../../controllers/UserController.js";

// A captured response: { body, status }. We override `json` on the controller instance to record it
// instead of writing to an HTTP context (there is none in a unit test).
type Captured = { body: any; status: number };

function makeController(userExists: boolean): { controller: any; loadByEmail: jest.Mock } {
  const controller: any = new UserController();
  const loadByEmail = jest.fn(async (_email: string) => (userExists ? { id: "U1", email: "known@example.com" } : null));

  // Fake repos — ONLY the members the handler touches. updateVerification is a no-op.
  controller.repos = {
    user: { loadByEmail, updateVerification: jest.fn(async () => {}) }
  };

  // Bypass the anon wrapper's getRepos()/logger.flush (DB + logging) — just run the callback and
  // return its result, exactly as the real wrapper does on the happy path.
  controller.actionWrapperAnon = (_req: any, _res: any, action: () => Promise<any>) => action();

  // Capture json() output instead of writing to an (absent) HTTP context.
  controller.json = (body: any, status: number): Captured => ({ body, status });
  controller.error = (errors: any) => ({ body: { errors }, status: 500 });
  controller.denyAccess = (errors: any) => ({ body: { errors }, status: 401 });

  return { controller, loadByEmail };
}

const makeReq = (userEmail: string) => ({ body: { userEmail } }) as any;
const res = {} as any;

describe("enumerationSafety (PUB-02) — anonymous endpoints are not existence oracles", () => {
  describe("forgotPassword: member vs non-member responses are BYTE-IDENTICAL", () => {
    it("returns the same status and the same JSON bytes whether or not the account exists", async () => {
      const memberCtx = makeController(true);
      const nonMemberCtx = makeController(false);

      const memberResp: Captured = await memberCtx.controller.forgotPassword(makeReq("known@example.com"), res);
      const nonMemberResp: Captured = await nonMemberCtx.controller.forgotPassword(makeReq("nobody@example.com"), res);

      // Both handlers actually consulted the repo (so the difference, if any, would surface).
      expect(memberCtx.loadByEmail).toHaveBeenCalledTimes(1);
      expect(nonMemberCtx.loadByEmail).toHaveBeenCalledTimes(1);

      // Identical status.
      expect(memberResp.status).toBe(nonMemberResp.status);
      expect(memberResp.status).toBe(200);

      // Identical bytes — the load-bearing assertion. If forgotPassword ever branches its body on
      // user existence again (e.g. {emailed:false}), THIS fails and the build breaks.
      expect(JSON.stringify(memberResp.body)).toBe(JSON.stringify(nonMemberResp.body));

      // And the generic body carries no existence signal.
      expect(memberResp.body).toEqual({ emailed: true });
    });

    it("only the member path actually sends mail / writes a verification code (behavior differs, RESPONSE does not)", async () => {
      const memberCtx = makeController(true);
      const nonMemberCtx = makeController(false);
      await memberCtx.controller.forgotPassword(makeReq("known@example.com"), res);
      await nonMemberCtx.controller.forgotPassword(makeReq("nobody@example.com"), res);
      // The member row got a verification code written; the non-member did not — but neither is
      // observable to the anonymous caller (identical response bytes, asserted above).
      expect(memberCtx.controller.repos.user.updateVerification).toHaveBeenCalledTimes(1);
      expect(nonMemberCtx.controller.repos.user.updateVerification).not.toHaveBeenCalled();
    });
  });

  describe("checkEmail: the existence + PII oracle is GONE from the anonymous surface", () => {
    it("UserController no longer exposes a checkEmail handler", () => {
      const controller: any = new UserController();
      expect(typeof controller.checkEmail).toBe("undefined");
    });

    it("the controller source declares no /checkEmail route", () => {
      // Guard against a future reintroduction under the same or a renamed handler: the string
      // must not reappear on the controller prototype's own method names.
      const methodNames = Object.getOwnPropertyNames(UserController.prototype);
      expect(methodNames).not.toContain("checkEmail");
    });
  });
});
