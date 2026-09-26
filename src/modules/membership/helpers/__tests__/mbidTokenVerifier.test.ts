// Mary Banks ID token verification (DB-free, network-free). A locally generated RSA key stands in for
// the Keycloak realm key; the JWKS fetcher is replaced so no request ever leaves the test.
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { MbidTokenVerifier, MbidTokenError } from "../mbid/MbidTokenVerifier.js";
import { MbidConfig } from "../mbid/MbidConfig.js";

const ISS = "https://id.mbmonline.global/realms/marybanks";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as any), kid: "kid-1", use: "sig", alg: "RS256" };

let fetches = 0;
let jwks: any = { keys: [jwk] };

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const sec = Math.floor(NOW / 1000);

function sign(claims: Record<string, any>, opts: { kid?: string; key?: crypto.KeyObject } = {}) {
  return jwt.sign(
    { iss: ISS, aud: "huro-app", azp: "huro-app", sub: "sub-123", email: "Mary@Example.org", email_verified: true, given_name: "Mary", family_name: "Banks", iat: sec, exp: sec + 300, ...claims },
    opts.key || privateKey,
    { algorithm: "RS256", keyid: opts.kid ?? "kid-1" }
  );
}

beforeEach(() => {
  MbidTokenVerifier.resetCache();
  fetches = 0;
  jwks = { keys: [jwk] };
  MbidTokenVerifier.fetcher = async () => { fetches++; return jwks; };
  delete process.env.MBID_ALLOWED_AUDIENCES;
  delete process.env.MBID_TEST_ISSUER;
  delete process.env.MBID_TEST_JWKS_FILE;
});

describe("MbidTokenVerifier", () => {
  it("accepts a valid token and returns its claims", async () => {
    const claims = await MbidTokenVerifier.verify(sign({}), NOW);
    expect(claims.sub).toBe("sub-123");
    expect(claims.email_verified).toBe(true);
  });

  it("caches the JWKS across verifications", async () => {
    await MbidTokenVerifier.verify(sign({}), NOW);
    await MbidTokenVerifier.verify(sign({}), NOW + 1000);
    expect(fetches).toBe(1);
  });

  it("refreshes once for an unknown kid (key rotation) and then accepts", async () => {
    await MbidTokenVerifier.verify(sign({}), NOW);
    const rotated = { ...(other.publicKey.export({ format: "jwk" }) as any), kid: "kid-2", use: "sig" };
    jwks = { keys: [jwk, rotated] };
    const claims = await MbidTokenVerifier.verify(sign({}, { kid: "kid-2", key: other.privateKey }), NOW + 31_000);
    expect(claims.sub).toBe("sub-123");
    expect(fetches).toBe(2);
  });

  it("does not hammer the JWKS for junk kids inside the refresh floor", async () => {
    await MbidTokenVerifier.verify(sign({}), NOW);
    await expect(MbidTokenVerifier.verify(sign({}, { kid: "nope" }), NOW + 1000)).rejects.toBeInstanceOf(MbidTokenError);
    expect(fetches).toBe(1);
  });

  it("rejects a bad signature (right kid, wrong key)", async () => {
    await expect(MbidTokenVerifier.verify(sign({}, { key: other.privateKey }), NOW)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("rejects the wrong issuer", async () => {
    await expect(MbidTokenVerifier.verify(sign({ iss: "https://evil.example/realms/marybanks" }), NOW)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("rejects an audience outside MBID_ALLOWED_AUDIENCES unless azp is allowed", async () => {
    await expect(MbidTokenVerifier.verify(sign({ aud: "other-app", azp: "other-app" }), NOW)).rejects.toMatchObject({ code: "invalid_token" });
    const viaAzp = await MbidTokenVerifier.verify(sign({ aud: ["account"], azp: "huro-app" }), NOW);
    expect(viaAzp.sub).toBe("sub-123");
    process.env.MBID_ALLOWED_AUDIENCES = "other-app";
    const custom = await MbidTokenVerifier.verify(sign({ aud: "other-app", azp: "other-app" }), NOW);
    expect(custom.sub).toBe("sub-123");
  });

  it("applies 60 s leeway to exp and no more", async () => {
    const t = sign({ exp: sec - 30 });
    expect((await MbidTokenVerifier.verify(t, NOW)).sub).toBe("sub-123");
    await expect(MbidTokenVerifier.verify(sign({ exp: sec - 90 }), NOW)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("refuses email_verified false (403 path) and missing email", async () => {
    await expect(MbidTokenVerifier.verify(sign({ email_verified: false }), NOW)).rejects.toMatchObject({ code: "email_unverified" });
    await expect(MbidTokenVerifier.verify(sign({ email: undefined }), NOW)).rejects.toMatchObject({ code: "email_unverified" });
  });

  it("rejects garbage, alg none and HS256 tokens signed with a guessable secret", async () => {
    await expect(MbidTokenVerifier.verify("not-a-token", NOW)).rejects.toMatchObject({ code: "invalid_token" });
    const none = jwt.sign({ iss: ISS, aud: "huro-app", sub: "x", email: "a@b.co", email_verified: true, exp: sec + 60 }, "", { algorithm: "none" as any, keyid: "kid-1" } as any);
    await expect(MbidTokenVerifier.verify(none, NOW)).rejects.toMatchObject({ code: "invalid_token" });
    const hs = jwt.sign({ iss: ISS, aud: "huro-app", sub: "x", email: "a@b.co", email_verified: true, exp: sec + 60 }, "secret", { algorithm: "HS256", keyid: "kid-1" });
    await expect(MbidTokenVerifier.verify(hs, NOW)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("emailsOf lower-cases the primary and verified_emails and de-duplicates", () => {
    const e = MbidTokenVerifier.emailsOf({ sub: "s", email: " Mary@Example.org ", verified_emails: ["OLD@example.org", "mary@example.org", "old@example.org"] });
    expect(e).toEqual({ primary: "mary@example.org", all: ["mary@example.org", "old@example.org"] });
  });
});

describe("MbidConfig test-only issuer override", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("is active only when NODE_ENV=test and ENVIRONMENT is not production", () => {
    process.env.MBID_TEST_ISSUER = "http://local-test-issuer";
    process.env.MBID_TEST_JWKS_FILE = "/tmp/jwks.json";
    process.env.NODE_ENV = "test";
    process.env.ENVIRONMENT = "dev";
    expect(MbidConfig.testOverrideActive).toBe(true);
    expect(MbidConfig.issuer).toBe("http://local-test-issuer");
    process.env.ENVIRONMENT = "prod";
    expect(MbidConfig.testOverrideActive).toBe(false);
    expect(MbidConfig.issuer).toBe(ISS);
    process.env.ENVIRONMENT = "dev";
    process.env.NODE_ENV = "production";
    expect(MbidConfig.testOverrideActive).toBe(false);
    expect(MbidConfig.issuer).toBe(ISS);
  });
});
