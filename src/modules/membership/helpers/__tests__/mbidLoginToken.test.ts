// The short-lived Mary Banks ID login token (DB-free): POST /users/login { jwt } accepts it while
// it is fresh, refuses it once expired, it lives at most 5 minutes, and it is NEVER accepted as a
// Bearer credential on any other endpoint.
import jwt from "jsonwebtoken";

const SECRET = "unit-test-jwt-secret";

jest.mock("@churchapps/apihelper", () => {
  class Principal { constructor(public details: any) {} }
  return {
    Principal,
    AuthenticatedUser: class {},
    // Minimal stand-in for the upstream provider: verify the bearer with the shared secret.
    CustomAuthProvider: class {
      async getUser(req: any) {
        const token = (req.headers?.authorization || "").split(" ")[1];
        if (!token) return null;
        const decoded = require("jsonwebtoken").verify(token, "unit-test-jwt-secret");
        return new Principal({ ...(decoded as any), jwt: token });
      }
    }
  };
});
// One mock for the membership helpers barrel (AuthenticatedUser reads Environment from it,
// CustomAuthProvider reads UserHelper from it).
jest.mock("../index.js", () => ({ Environment: { jwtSecret: "unit-test-jwt-secret", jwtExpiration: "2 days" }, UserHelper: {} }));
jest.mock("../../../../shared/helpers/Environment.js", () => ({ Environment: { jwtSecret: "unit-test-jwt-secret", jwtExpiration: "2 days" } }));
jest.mock("../../repositories/index.js", () => ({ Repos: { getCurrent: () => ({}) } }));

import { AuthenticatedUser } from "../../auth/AuthenticatedUser.js";
import { CustomAuthProvider } from "../../../../shared/infrastructure/CustomAuthProvider.js";

const USER: any = { id: "U1", email: "mary@example.org", firstName: "Mary", lastName: "Banks" };
const repos: any = { user: { load: jest.fn(async (id: string) => (id === "U1" ? USER : null)) } };

describe("Mary Banks ID login token", () => {
  afterEach(() => jest.useRealTimers());

  it("is signed with purpose mbid_login and expires in at most 5 minutes", () => {
    const token = AuthenticatedUser.getMbidLoginJwt(USER);
    const payload: any = jwt.verify(token, SECRET);
    expect(payload.purpose).toBe("mbid_login");
    expect(payload.id).toBe("U1");
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(300);
  });

  it("POST /users/login { jwt } path (loadUserByJwt) accepts it while fresh", async () => {
    const token = AuthenticatedUser.getMbidLoginJwt(USER);
    expect(await AuthenticatedUser.loadUserByJwt(token, repos)).toBe(USER);
  });

  it("an expired login token is rejected", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-26T12:00:00Z") });
    const token = AuthenticatedUser.getMbidLoginJwt(USER);
    jest.setSystemTime(new Date("2026-09-26T12:05:01Z"));
    expect(await AuthenticatedUser.loadUserByJwt(token, repos)).toBeNull();
  });

  it("a token signed with another secret is rejected (normal login is not weakened)", async () => {
    const forged = jwt.sign({ id: "U1", purpose: "mbid_login" }, "not-the-secret", { expiresIn: 60 });
    expect(await AuthenticatedUser.loadUserByJwt(forged, repos)).toBeNull();
  });

  it("is refused as a Bearer credential, while a normal session JWT still works", async () => {
    const provider = new CustomAuthProvider();
    const loginToken = AuthenticatedUser.getMbidLoginJwt(USER);
    expect(await provider.getUser({ headers: { authorization: "Bearer " + loginToken } }, {}, () => {})).toBeNull();
    const session = jwt.sign({ id: "U1", churchId: "CHU1", permissions: [] }, SECRET, { expiresIn: "2 days" });
    const principal: any = await provider.getUser({ headers: { authorization: "Bearer " + session } }, {}, () => {});
    expect(principal?.details?.id).toBe("U1");
  });
});
