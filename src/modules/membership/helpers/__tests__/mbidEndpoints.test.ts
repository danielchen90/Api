// ── Members round anonymous-leak / enumeration gate (DB-free) ───────────────────────────────────
// Drives the REAL UserController.mbidLogin and MeController handlers over mocked seams:
//   - mbidLogin is not an account oracle: a bad / unverified token is refused identically whether
//     or not the email has an account (and before any lookup), and a valid token gets the same
//     response shape for an existing account and a brand-new one;
//   - every /me/* endpoint answers 401 without a signed-in member (user id + church id).
import crypto from "crypto";
import jwt from "jsonwebtoken";

jest.mock("@churchapps/apihelper", () => ({
  ArrayHelper: { getOne: () => null, getAll: () => [] },
  EnvironmentBase: class {},
  CustomBaseController: class {},
  AuthenticatedUser: class {},
  Principal: class {}
}));
jest.mock("../../auth/index.js", () => ({ AuthenticatedUser: { getMbidLoginJwt: (u: any) => "LOGIN_TOKEN_FOR_" + (u.isNew ? "NEW" : "OLD").replace(/./g, "x") } }));
jest.mock("../../../../shared/infrastructure/index.js", () => ({
  RepoManager: { getRepos: async () => ({}) },
  BaseController: class {
    public logger = { flush: async () => {}, error: () => {} };
    constructor(_m?: string) {}
    json(body: any, status: number) { return { body, status }; }
    error(errors: any) { return { body: { errors }, status: 500 }; }
    denyAccess(errors: any) { return { body: { errors }, status: 401 }; }
    actionWrapperAnon(_req: any, _res: any, action: () => Promise<any>) { return action(); }
    actionWrapper(req: any, _res: any, action: (au: any) => Promise<any>) { return action(req.__au || {}); }
  }
}));
jest.mock("../index.js", () => ({
  Environment: { isMailConfigured: true, currentEnvironment: "test" },
  Permissions: {},
  EmailHelper: {},
  UserHelper: {},
  UserChurchHelper: {},
  UniqueIdHelper: { shortId: () => "sid" },
  AuditLogHelper: { log: jest.fn(), getClientIp: jest.fn(() => "127.0.0.1"), logLogin: jest.fn() },
  MauticHelper: {},
  ChurchHelper: {}
}));
jest.mock("../AuditLogHelper.js", () => ({ AuditLogHelper: { log: jest.fn(), getClientIp: jest.fn(() => "127.0.0.1") } }));

// The real MemberAccountService over tiny fakes; `lookups` counts every repo touch.
let lookups = 0;
let existingUser = false;
jest.mock("../mbid/MemberServiceFactory.js", () => {
  const { MemberAccountService } = jest.requireActual("../mbid/MemberAccountService.js");
  return {
    buildMemberAccountService: () => {
      const count = <T>(v: T) => { lookups++; return v; };
      const repos: any = {
        church: { loadBySubDomain: async (sd: string) => count(sd === "bti" ? { id: "CHU1" } : null) },
        user: {
          loadByEmail: async () => count(existingUser ? { id: "U_OLD", email: "mary@example.org", firstName: "Mary" } : null),
          save: async (u: any) => count(Object.assign(u, { id: "U_NEW", isNew: true }))
        },
        person: { load: async () => count(null) },
        memberAccount: {
          loadUserByMbidSub: async () => count(null),
          loadMbidSub: async () => count(null),
          setMbidSub: async () => count(undefined),
          ensureUserChurch: async () => count({ id: "UC", personId: null }),
          findPeopleByEmails: async () => count([]),
          loadLinkedUserIds: async () => count([])
        }
      };
      return new MemberAccountService({ repos, admin: null, sendCode: async () => {}, audit: () => {}, loadPermissions: async () => [] });
    }
  };
});

import { UserController } from "../../controllers/UserController.js";
import { MeController } from "../../controllers/MeController.js";
import { MbidTokenVerifier } from "../mbid/MbidTokenVerifier.js";

const ISS = "https://id.mbmonline.global/realms/marybanks";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as any), kid: "k1", use: "sig" };
const idToken = (over: any = {}) => jwt.sign(
  { iss: ISS, aud: "huro-app", sub: "kc-1", email: "mary@example.org", email_verified: true, given_name: "Mary", family_name: "Banks", exp: Math.floor(Date.now() / 1000) + 300, ...over },
  privateKey,
  { algorithm: "RS256", keyid: "k1" }
);

const call = async (body: any) => {
  const c: any = new UserController();
  c.repos = {};
  return c.mbidLogin({ body, headers: {}, socket: {} } as any, {} as any);
};

beforeEach(() => {
  lookups = 0;
  existingUser = false;
  UserController.mbidLimiter.reset();
  MbidTokenVerifier.resetCache();
  MbidTokenVerifier.fetcher = async () => ({ keys: [jwk] });
});

describe("POST /membership/users/mbidLogin is not an account oracle", () => {
  it("a forged / garbage token is refused with the same 401 whether or not the email has an account, before any lookup", async () => {
    const forged = jwt.sign({ iss: ISS, aud: "huro-app", sub: "kc-1", email: "mary@example.org", email_verified: true, exp: Math.floor(Date.now() / 1000) + 300 }, crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, { algorithm: "RS256", keyid: "k1" });
    existingUser = true;
    const a = await call({ idToken: forged, subDomain: "bti" });
    existingUser = false;
    const b = await call({ idToken: forged, subDomain: "bti" });
    const c = await call({ idToken: "garbage", subDomain: "bti" });
    expect(a).toEqual({ status: 401, body: { error: "invalid_token" } });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    expect(lookups).toBe(0);
  });

  it("an unverified email is refused with 403 before any lookup, identically for known and unknown emails", async () => {
    existingUser = true;
    const a = await call({ idToken: idToken({ email_verified: false }), subDomain: "bti" });
    existingUser = false;
    const b = await call({ idToken: idToken({ email_verified: false, email: "nobody@example.org" }), subDomain: "bti" });
    expect(a).toEqual({ status: 403, body: { error: "email_unverified" } });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(lookups).toBe(0);
  });

  it("a valid token gets the same response shape for an existing account and a new one", async () => {
    existingUser = true;
    const a = await call({ idToken: idToken(), subDomain: "bti" });
    existingUser = false;
    const b = await call({ idToken: idToken(), subDomain: "bti" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(Object.keys(a.body).sort()).toEqual(["firstName", "jwt"]);
    expect(Object.keys(b.body).sort()).toEqual(["firstName", "jwt"]);
    expect(a.body.firstName).toBe("Mary");
    expect(b.body.firstName).toBe("Mary");
    expect(a.body.jwt.length).toBe(b.body.jwt.length);
  });

  it("is rate limited per IP", async () => {
    UserController.mbidLimiter.maxHits = 2;
    try {
      await call({ idToken: "x" });
      await call({ idToken: "x" });
      expect(await call({ idToken: "x" })).toEqual({ status: 429, body: { error: "too_many" } });
    } finally {
      UserController.mbidLimiter.maxHits = 120;
    }
  });
});

describe("/membership/me/* require a signed-in member", () => {
  const routes: [string, (c: any, req: any) => Promise<any>][] = [
    ["GET /me/overview", (c, r) => c.overview(r, {})],
    ["POST /me/person", (c, r) => c.person(r, {})],
    ["POST /me/claim", (c, r) => c.claim(r, {})],
    ["POST /me/emails/start", (c, r) => c.emailsStart(r, {})],
    ["POST /me/emails/verify", (c, r) => c.emailsVerify(r, {})],
    ["DELETE /me/emails/:email", (c, r) => c.emailsRemove("a@b.co", r, {})],
    ["GET /me/submissions", (c, r) => c.submissions(r, {})]
  ];
  for (const [name, fn] of routes) {
    it(name + " -> 401 anonymous, and 401 for a token without a church", async () => {
      const c: any = new MeController();
      c.repos = {};
      expect(await fn(c, { body: { personId: "P1", email: "a@b.co", code: "123456" }, headers: {}, socket: {} })).toEqual({ status: 401, body: { error: "unauthorized" } });
      expect(await fn(c, { __au: { id: "U1" }, body: {}, headers: {}, socket: {} })).toEqual({ status: 401, body: { error: "unauthorized" } });
      expect(lookups).toBe(0);
    });
  }
});
