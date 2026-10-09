// Mary Banks ID account deletion endpoint (DB-free): HMAC gate, idempotent answers, retryable
// failures, and the tombstone rule that keeps the CRM activity pull from re-creating the person.
import crypto from "crypto";

jest.mock("@churchapps/apihelper", () => ({ FileStorageHelper: { remove: jest.fn() }, CustomBaseController: class {} }));
jest.mock("../../../../shared/infrastructure/KyselyPool.js", () => ({ KyselyPool: { getDb: () => ({}) } }));
jest.mock("../../db/index.js", () => ({ getDb: () => ({}) }));
jest.mock("../../../../shared/infrastructure/index.js", () => ({
  BaseController: class {
    constructor(_m?: string) {}
    json(body: any, status: number) { return { body, status }; }
    actionWrapperAnon(_req: any, _res: any, action: () => Promise<any>) { return action(); }
  }
}));
jest.mock("../index.js", () => ({ Permissions: {} }));
jest.mock("../mbid/MbidAccountErasure.js", () => {
  const actual = jest.requireActual("../mbid/MbidAccountErasure.js");
  return { ...actual, MbidAccountErasure: Object.assign(Object.create(actual.MbidAccountErasure), { erase: jest.fn(), isErased: actual.MbidAccountErasure.isErased }) };
});

import { MbidController } from "../../controllers/MbidController.js";
import { MbidAccountErasure } from "../mbid/MbidAccountErasure.js";

const SECRET = "test-secret";
const SUB = "4f1c2b3a-0000-4000-8000-123456789abc";
const sign = (ts: string, sub = SUB, secret = SECRET) => crypto.createHmac("sha256", secret).update(`${ts}.${sub}`).digest("hex");
const now = () => String(Math.floor(Date.now() / 1000));
const call = (headers: Record<string, string>, body: any = { sub: SUB }) => new MbidController().accountDeleted({ headers, body } as any, {} as any) as any;
const erase = MbidAccountErasure.erase as jest.Mock;

describe("POST /membership/mbid/account-deleted", () => {
  beforeEach(() => { process.env.MBID_DELETION_SECRET = SECRET; erase.mockReset(); });
  afterAll(() => { delete process.env.MBID_DELETION_SECRET; });

  it("answers 503 when the secret is not set", async () => {
    delete process.env.MBID_DELETION_SECRET;
    const ts = now();
    expect((await call({ "x-mbid-timestamp": ts, "x-mbid-signature": sign(ts) })).status).toBe(503);
    expect(erase).not.toHaveBeenCalled();
  });

  it("refuses a wrong signature, a stale timestamp, and a signature for another sub", async () => {
    const ts = now();
    expect((await call({ "x-mbid-timestamp": ts, "x-mbid-signature": sign(ts, SUB, "other") })).status).toBe(401);
    const old = String(Number(ts) - 301);
    expect((await call({ "x-mbid-timestamp": old, "x-mbid-signature": sign(old) })).status).toBe(401);
    expect((await call({ "x-mbid-timestamp": ts, "x-mbid-signature": sign(ts, "someone-else") })).status).toBe(401);
    expect((await call({})).status).toBe(401);
    expect(erase).not.toHaveBeenCalled();
  });

  it("answers found:false for an unknown or already erased sub", async () => {
    erase.mockResolvedValue({ found: false, erased: {} });
    const ts = now();
    const r = await call({ "x-mbid-timestamp": ts, "x-mbid-signature": sign(ts) });
    expect(r).toEqual({ status: 200, body: { ok: true, found: false } });
    expect(erase).toHaveBeenCalledWith(SUB);
  });

  it("reports the counts on success and 500 on failure", async () => {
    const ts = now();
    erase.mockResolvedValue({ found: true, erased: { users: 1, "people(anonymized)": 1 } });
    expect(await call({ "x-mbid-timestamp": ts, "x-mbid-signature": sign(ts) })).toEqual({ status: 200, body: { ok: true, found: true, erased: { users: 1, "people(anonymized)": 1 } } });
    erase.mockRejectedValue(new Error("db down"));
    expect((await call({ "x-mbid-timestamp": ts, "x-mbid-signature": sign(ts) })).status).toBe(500);
  });
});

describe("erasure tombstones", () => {
  const hash = (kind: string, v: string) => "erased:" + crypto.createHash("sha256").update(kind + ":" + v).digest("hex").slice(0, 56);
  const at = new Date("2026-10-09T12:00:00Z");
  const stones = new Map([[hash("sub", SUB), at], [hash("email", "gone@example.com"), at]]);

  it("skips every row from an erased sub", () => {
    expect(MbidAccountErasure.isErased(stones, { sub: SUB, occurredAt: new Date("2030-01-01") })).toBe(true);
  });

  it("skips email-only history from before the erase, not a later fresh start", () => {
    expect(MbidAccountErasure.isErased(stones, { email: " Gone@Example.com ", occurredAt: new Date("2026-10-01") })).toBe(true);
    expect(MbidAccountErasure.isErased(stones, { email: "gone@example.com", occurredAt: new Date("2026-10-10") })).toBe(false);
    expect(MbidAccountErasure.isErased(stones, { sub: "other", email: "someone@example.com" })).toBe(false);
  });
});
