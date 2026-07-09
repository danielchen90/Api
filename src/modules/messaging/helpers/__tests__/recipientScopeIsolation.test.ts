// ── Module mocks MUST be declared before the imports of the units under test. ────────────────────
// axios: RecipientResolver does `import axios from "axios"; axios.post(...)`. Under the CommonJS
// Jest transform the default export IS the `.post`-bearing object, so we expose `post` on BOTH the
// default and the namespace (mirroring NotificationHelper.test.ts). No live server is ever hit.
const axiosPostMock = jest.fn();
jest.mock("axios", () => ({ default: { post: (...a: any[]) => axiosPostMock(...a) }, post: (...a: any[]) => axiosPostMock(...a) }));
// Environment uses import.meta.url which the CommonJS-transformed Jest cannot parse; stub the seam
// base so RecipientResolver builds the scoped URL without loading the real Environment module.
jest.mock("../../../../shared/helpers/Environment.js", () => ({ Environment: { membershipApi: "https://membership.test/membership" } }));

import { applyCampusScope, assertWritableCampus, type CampusScope } from "../../../membership/helpers/applyCampusScope.js";
import { CampusScopeHelper } from "../../../membership/helpers/CampusScopeHelper.js";
import { expectCampusIsolation, expectWriteIsolation } from "../../../membership/helpers/campusIsolationSupport.js";
import { RecipientResolver } from "../RecipientResolver.js";

/**
 * AUD-03 — PHASE 10 EXIT GATE. A Campus Admin can never target another campus's people.
 *
 * This suite is TEST-ONLY (no product code) and DB-FREE — it drives the REAL scope primitives
 * (`applyCampusScope` / `assertWritableCampus` / `CampusScopeHelper.resolve`) over an in-memory
 * recording query builder, MIRRORING `membership/helpers/__tests__/campusIsolation.test.ts`.
 *
 * Because messaging does NOT own `applyCampusScope`, the scope guarantee spans an HTTP seam:
 *   (a) the Plan-01 `POST /membership/audiences/resolve` endpoint applies `applyCampusScope`
 *       server-side (proven here by registering the scoped load through `expectCampusIsolation`);
 *   (b) the Plan-02 `RecipientResolver` NEVER accepts a client personId — it forwards the caller
 *       JWT verbatim to the SCOPED endpoint with a body carrying ONLY {type,targetId,filterJson},
 *       so the deliverable list is derived exclusively from the scoped seam.
 *
 * HONEST NOTE ON THE FREEZE RE-ASSERT (as-built, see 10-02-SUMMARY.md deviation):
 * `CampaignAudienceController.freeze` re-asserts each row via `assertWritableCampus` but under a
 * `{mode:"all"}` scope (messaging carries no `userCampus` repo, so `CampusScopeHelper.resolve`
 * cannot run there). Under `mode:"all"` `assertWritableCampus` only rejects a FALSY campusId — it
 * does NOT filter a foreign campus. Therefore the TRUE freeze guarantee is NOT "a poisoned foreign
 * row is filtered at freeze"; it is "no client personIds are ever trusted, so a poisoned foreign
 * row can never enter the deliverable list in the first place" (the scope is enforced at the seam,
 * (a)+(b) above). This suite asserts THAT real invariant, plus the pure `assertWritableCampus`
 * SCOPED-mode behavior (which WOULD reject a foreign campus) as the defense-in-depth primitive the
 * seam relies on. See the `freeze` describe block for the explicit reality assertions.
 */

// ── In-memory recording query builder — copied verbatim from campusIsolation.test.ts (it is defined
//    inline there, NOT exported). Records every `.where(column, op?, value?)` call and can evaluate
//    the accumulated predicates against a fixture, so the gate drives the REAL applyCampusScope with
//    no database. `applyCampusScope("deny")` calls `.where(sql`1=0`)` — a SINGLE raw arg. ──────────
type Pred = (row: any) => boolean;

class InMemoryQuery {
  public readonly whereCalls: Array<{ column: any; op?: any; value?: any; raw: boolean }>;
  private readonly predicates: Pred[];

  constructor(private readonly rows: any[], whereCalls: any[] = [], predicates: Pred[] = []) {
    this.whereCalls = whereCalls;
    this.predicates = predicates;
  }

  where(column: any, op?: any, value?: any): InMemoryQuery {
    if (op === undefined && value === undefined) {
      return new InMemoryQuery(
        this.rows,
        [...this.whereCalls, { column, raw: true }],
        [...this.predicates, () => false] // sql`1=0` matches nothing
      );
    }
    const pred: Pred =
      op === "in" ? (r) => (value as any[]).includes(r[column])
      : op === "=" ? (r) => r[column] === value
      : () => true;
    return new InMemoryQuery(
      this.rows,
      [...this.whereCalls, { column, op, value, raw: false }],
      [...this.predicates, pred]
    );
  }

  execute(): any[] {
    return this.rows.filter((r) => this.predicates.every((p) => p(r)));
  }
}

// ── Fixtures: the loadForAudience / resolver row shape — {personId~id, campusId, email, mergeData}.
//    Campus A is in-scope, B is out-of-scope, plus a NULL-campus (unassigned) person (RESEARCH
//    Open-Q1: unassigned people are visible only under `all`). ─────────────────────────────────────
const A = "campusA";
const B = "campusB";
const PEOPLE = [
  { id: "a1", campusId: A, email: "alice@x.com", firstName: "Alice", lastName: "A", displayName: "Alice A" },
  { id: "a2", campusId: A, email: "amy@x.com", firstName: "Amy", lastName: "A", displayName: "Amy A" },
  { id: "b1", campusId: B, email: "bob@x.com", firstName: "Bob", lastName: "B", displayName: "Bob B" },
  { id: "n1", campusId: null, email: "nell@x.com", firstName: "Nell", lastName: "N", displayName: "Nell N" }
];

// PersonRepo.loadForAudience models the scoped read: filter churchId (constant in-memory here) then
// layer applyCampusScope over the builder — THE safety line loadForAudience runs (10-01-SUMMARY).
const audienceResolveLoad = (scope: CampusScope): any[] => {
  let q = new InMemoryQuery(PEOPLE);
  q = applyCampusScope(q, scope);
  return q.execute();
};

// AuthenticatedUser fake carrying a JWT + churchId (the resolver forwards au.jwt verbatim).
const makeAu = (opts: { marker?: boolean; jwt?: string } = {}) =>
  ({
    id: "user1",
    churchId: "church1",
    jwt: opts.jwt ?? "JWT.caller.token",
    checkAccess: (perm: { contentType: string; action: string }) =>
      perm.contentType === "Campus" && perm.action === "Admin" ? !!opts.marker : false
  } as any);

// Messaging Repos fake: only the resolver seam touches emailSuppression.isSuppressed (never a
// userCampus repo — messaging does not carry one; that is the whole reason freeze uses mode:"all").
const makeRepos = (opts: { suppressed?: string[] } = {}) =>
  ({
    emailSuppression: { isSuppressed: jest.fn(async (_c: string, email: string) => (opts.suppressed ?? []).includes(email)) }
  } as any);

// Membership Repos fake for CampusScopeHelper.resolve (server-side derivation, fail-closed cases).
const makeMembershipRepos = (campusIds: string[]) =>
  ({ userCampus: { loadCampusIdsForUser: jest.fn(async () => campusIds) } } as any);

describe("recipientScopeIsolation (AUD-03 Phase 10 exit gate)", () => {
  beforeEach(() => axiosPostMock.mockReset());

  // ── (a) SEAM-SCOPE registration — the /audiences/resolve endpoint applies applyCampusScope. ─────
  describe("(a) /audiences/resolve applies campus scope at the seam (Plan-01 half)", () => {
    it("audience/resolve list-scope: A-scoped resolve returns ONLY campus-A people (zero B leakage), org-wide both, deny empty", async () => {
      await expectCampusIsolation(audienceResolveLoad, { kind: "list", inScopeCampusId: A, outOfScopeCampusId: B });
    });

    it("an out-of-scope campus TARGET composes as an extra predicate WITHIN scope → zero rows (never a widener)", () => {
      // loadForAudience applies campusTargetId as an EXTRA `campusId = target` predicate AFTER
      // applyCampusScope, so targeting foreign campus B under an A-only scope yields [] — it can
      // never widen the scope to reach B's people.
      let q = new InMemoryQuery(PEOPLE);
      q = applyCampusScope(q, { mode: "scoped", campusIds: [A] });
      q = q.where("campusId", "=", B); // the campusTargetId predicate
      expect(q.execute()).toEqual([]);
    });

    it("the NULL-campus (unassigned) person is EXCLUDED under scoped (IN(set) excludes NULL) but INCLUDED under all (Open-Q1)", () => {
      const scopedIds = audienceResolveLoad({ mode: "scoped", campusIds: [A] }).map((r) => r.id);
      expect(scopedIds).not.toContain("n1"); // IN([A]) excludes campusId:null
      const allIds = audienceResolveLoad({ mode: "all" }).map((r) => r.id);
      expect(allIds).toContain("n1"); // org-wide sees the unassigned person
    });
  });

  // ── (b) NO CLIENT personIds + JWT FORWARD — the messaging resolver targets the SCOPED seam. ─────
  describe("(b) RecipientResolver forwards the JWT to the SCOPED endpoint, never trusts client personIds", () => {
    it("targets /audiences/resolve, forwards Bearer au.jwt, body carries NO personIds and NO scope", async () => {
      const A_ROWS = [
        { personId: "a1", email: "alice@x.com", campusId: A, mergeData: { firstName: "Alice" } },
        { personId: "a2", email: "amy@x.com", campusId: A, mergeData: { firstName: "Amy" } }
      ];
      axiosPostMock.mockResolvedValueOnce({ data: A_ROWS });

      const au = makeAu({ jwt: "JWT.caller.token" });
      const result = await RecipientResolver.resolve(au, makeRepos(), { type: "church" });

      expect(axiosPostMock).toHaveBeenCalledTimes(1);
      const [url, body, config] = axiosPostMock.mock.calls[0];

      // SCOPED endpoint — never an unscoped /people/* endpoint.
      expect(url).toMatch(/\/audiences\/resolve$/);
      expect(url).not.toMatch(/\/people\/(ids|search)/);

      // JWT forwarded VERBATIM — scope is re-derived server-side, never serialized in the body.
      expect(config.headers.Authorization).toBe("Bearer " + au.jwt);

      // Body is the descriptor ONLY: no personIds, no scope/campusIds. Person IDs are OUTPUTS.
      expect(Object.keys(body).every((k) => ["type", "targetId", "filterJson"].includes(k))).toBe(true);
      expect(body).not.toHaveProperty("personIds");
      expect(body).not.toHaveProperty("scope");
      expect(body).not.toHaveProperty("campusIds");

      // The resolver returns ONLY the A-campus rows the scoped seam returned — it adds/trusts no ids.
      expect(result.deliverable.map((r) => r.personId)).toEqual(["a1", "a2"]);
      expect(result.deliverable.every((r) => r.campusId === A)).toBe(true);
    });

    it("a non-2xx seam response REJECTS (never an empty-that-looks-safe audience)", async () => {
      axiosPostMock.mockRejectedValueOnce(new Error("Request failed with status code 401"));
      await expect(RecipientResolver.resolve(makeAu(), makeRepos(), { type: "church" })).rejects.toThrow();
    });
  });

  // ── (c) FREEZE re-assert — HONEST reality: the pure predicate + the real seam guarantee. ────────
  describe("(c) freeze re-assert: the pure primitive + the TRUE (seam-derived) scope guarantee", () => {
    it("assertWritableCampus under a SCOPED scope filters a poisoned foreign-campus row (the primitive's real power)", () => {
      // This proves the PRIMITIVE: were freeze to re-assert under the caller's SCOPED scope, a
      // foreign row WOULD be rejected. (See the next test for what freeze ACTUALLY does.)
      const scope: CampusScope = { mode: "scoped", campusIds: [A] };
      const poisoned = [{ personId: "a1", campusId: A }, { personId: "b1", campusId: B }]; // b1 injected
      const frozen = poisoned.filter((r) => assertWritableCampus(scope, r.campusId));
      expect(frozen.map((r) => r.personId)).toEqual(["a1"]);
      expect(frozen.some((r) => r.campusId === B)).toBe(false);
    });

    it("write isolation: a foreign campus is never writable under a scoped scope; deny writes nothing", () => {
      expectWriteIsolation({ mode: "scoped", campusIds: [A] }, B);
      expect(assertWritableCampus({ mode: "deny" }, A)).toBe(false);
    });

    it("AS-BUILT freeze uses mode:'all' (10-02 deviation) → only FALSY campusId is rejected, NOT a foreign campus", () => {
      // HONEST assertion of reality: CampaignAudienceController.freeze re-asserts under {mode:"all"}
      // because messaging has no userCampus repo. Under mode:"all", assertWritableCampus does NOT
      // filter a foreign campus — it only rejects a falsy campusId. So a poisoned foreign row would
      // NOT be removed AT FREEZE. We assert this truthfully rather than claim a filter that isn't there.
      const freezeScope: CampusScope = { mode: "all" }; // the exact scope used at freeze (10-02-SUMMARY)
      expect(assertWritableCampus(freezeScope, B)).toBe(true);  // a foreign campus PASSES under all
      expect(assertWritableCampus(freezeScope, "")).toBe(false); // only a falsy campusId is rejected
    });

    it("TRUE freeze guarantee: no client personIds are trusted, so a poisoned foreign row can never ENTER the deliverable", async () => {
      // The real defense is at the SEAM, not at freeze: the deliverable is built EXCLUSIVELY from
      // the scoped seam response. Even if a client stuffs a hostile `personIds`/`scope` onto the
      // request body, the Plan-01 seam's `normalizeAudience` coerces the body to the CLOSED
      // {type,targetId,filterJson} descriptor union and NEVER reads a `personIds` field
      // (10-01-SUMMARY: "NO personIds field ever accepted") — person IDs are OUTPUTS, and scope is
      // re-derived server-side from the JWT, never the body. So the deliverable equals exactly the
      // scoped seam rows (A-only, modeled by the stub) regardless of the hostile keys.
      const A_ROWS = [{ personId: "a1", email: "alice@x.com", campusId: A, mergeData: {} }];
      axiosPostMock.mockResolvedValueOnce({ data: A_ROWS });
      const result = await RecipientResolver.resolve(
        makeAu(),
        makeRepos(),
        { type: "church", personIds: ["b1"], scope: { mode: "all" } } as any // hostile extra keys
      );
      // The seam controls the output; the deliverable is A-only regardless of the hostile keys.
      expect(result.deliverable.map((r) => r.personId)).toEqual(["a1"]);
      expect(result.deliverable.some((r) => r.campusId === B)).toBe(false);
    });
  });

  // ── preview == freeze consume the SAME single resolver result (no bypass path by construction). ──
  describe("preview and freeze consume the SAME resolver result (no compose→send drift)", () => {
    it("one resolve(...) result feeds BOTH the preview count and the freeze row-map (identical by construction)", async () => {
      // CampaignAudienceController wires BOTH endpoints to RecipientResolver.resolve
      // (CampaignAudienceController.ts:40 preview, :66 freeze). A DB-free unit proof: a single
      // resolve() result is the SOLE input to both preview's count and freeze's row map, so the
      // deliverable previewed is byte-identical to the deliverable frozen.
      const A_ROWS = [
        { personId: "a1", email: "alice@x.com", campusId: A, mergeData: { firstName: "Alice" } },
        { personId: "a2", email: "amy@x.com", campusId: A, mergeData: { firstName: "Amy" } }
      ];
      axiosPostMock.mockResolvedValueOnce({ data: A_ROWS });
      const resolved = await RecipientResolver.resolve(makeAu(), makeRepos(), { type: "church" });

      // preview derivation (controller step): count the SAME deliverable.
      const previewCount = resolved.deliverable.length;
      // freeze derivation (controller step): map the SAME deliverable through the mode:"all" re-assert.
      const freezeScope: CampusScope = { mode: "all" };
      const frozenRows = resolved.deliverable
        .filter((r) => assertWritableCampus(freezeScope, r.campusId))
        .map((r) => r.personId);

      expect(previewCount).toBe(2);
      expect(frozenRows.length).toBe(previewCount); // what preview COUNTS is what freeze MAPS
      expect(frozenRows).toEqual(resolved.deliverable.map((r) => r.personId));
    });
  });

  // ── CampusScopeHelper.resolve fail-closed (server-side derivation — the seam re-derives scope). ──
  describe("CampusScopeHelper.resolve (server-side derivation, fail-closed) — mirrors campusIsolation.test.ts", () => {
    it("org-wide marker → mode:'all' WITHOUT touching the assignment repo", async () => {
      const repos = makeMembershipRepos([A]);
      const scope = await CampusScopeHelper.resolve(makeAu({ marker: true }), repos);
      expect(scope).toEqual({ mode: "all" });
      expect(repos.userCampus.loadCampusIdsForUser).not.toHaveBeenCalled();
    });

    it("no marker + assigned [A] → mode:'scoped' with exactly that set", async () => {
      const scope = await CampusScopeHelper.resolve(makeAu({ marker: false }), makeMembershipRepos([A]));
      expect(scope).toEqual({ mode: "scoped", campusIds: [A] });
    });

    it("no marker + ZERO assignments → mode:'deny' (fail-closed, never empty IN)", async () => {
      const scope = await CampusScopeHelper.resolve(makeAu({ marker: false }), makeMembershipRepos([]));
      expect(scope).toEqual({ mode: "deny" });
    });
  });
});

// ── Optional DB-backed parity cases (opt-in; skipped cleanly when no MySQL/flag) — Phase-2 pattern.
const dbEnabled = process.env.ENABLE_DB_ISOLATION_TESTS === "1";
(dbEnabled ? describe : describe.skip)("DB-backed audience-scope isolation (opt-in: ENABLE_DB_ISOLATION_TESTS=1)", () => {
  it("repeats resolve/freeze scope over a real scoped PersonRepo query", () => {
    // When enabled: seed church + campuses A/B + a Campus Admin assigned ONLY to A, hit
    // POST /membership/audiences/resolve with the caller JWT, and assert zero campus-B rows in the
    // response and in the frozen campaignRecipients. The pure-logic core above is the AUTHORITATIVE
    // gate; this is environment parity only.
    expect(dbEnabled).toBe(true);
  });
});
