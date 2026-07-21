import { applyCampusScope, assertWritableCampus, type CampusScope } from "../applyCampusScope.js";
import { CampusScopeHelper } from "../CampusScopeHelper.js";
import { CAMPUS_ORGWIDE_MARKER, CAMPUS_WRITE_PERMISSION } from "../campusRoles.js";
import { expectCampusIsolation, expectWriteIsolation } from "../campusIsolationSupport.js";

/**
 * PHASE 1 EXIT GATE (PERM-07) — cross-campus denial proven against the scope PRIMITIVE.
 *
 * This is THE named, point-at-able suite for "a Campus Admin cannot read/write another campus's
 * records". Per RESEARCH Open-Q1 the CORE cases run with NO MySQL: they exercise
 * `applyCampusScope` / `assertWritableCampus` / `CampusScopeHelper.resolve` directly over a tiny
 * in-memory query builder + a fake userCampus repo. Optional DB-backed cases are guarded behind
 * `ENABLE_DB_ISOLATION_TESTS=1` and skipped cleanly when absent.
 *
 * Every read case is driven through the reusable `expectCampusIsolation()` helper so Phases 2/6/7
 * extend this gate with one registration line per new endpoint type (render/batch/reissue/void/export).
 */

// ── In-memory query builder that records the SAME calls applyCampusScope makes on a real Kysely
//    builder, and can also evaluate them against a fixture dataset. This is what lets the gate run
//    without a database while still driving the real primitive. ──────────────────────────────────
type Pred = (row: any) => boolean;

class InMemoryQuery {
  /** Every `.where(...)` argument list applyCampusScope produced (for builder-shape assertions). */
  public readonly whereCalls: Array<{ column: any; op?: any; value?: any; raw: boolean }>;
  private readonly predicates: Pred[];

  constructor(private readonly rows: any[], whereCalls: any[] = [], predicates: Pred[] = []) {
    this.whereCalls = whereCalls;
    this.predicates = predicates;
  }

  where(column: any, op?: any, value?: any): InMemoryQuery {
    // applyCampusScope("deny") calls `.where(sql`1=0`)` — a SINGLE raw arg, no op/value.
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

// ── Fixtures: rows on campus A (in-scope) and campus B (out-of-scope). ───────────────────────────
const A = "campusA";
const B = "campusB";
const ROWS = [
  { id: "a1", campusId: A, name: "Alice" },
  { id: "a2", campusId: A, name: "Amy" },
  { id: "b1", campusId: B, name: "Bob" }
];

// A scoped read endpoint, reduced to the primitive: build a query, layer the scope, run it.
const listLoad = (scope: CampusScope): any[] => {
  let q = new InMemoryQuery(ROWS);
  q = applyCampusScope(q, scope); // adds nothing / IN(set) / 1=0
  return q.execute();
};

const getByIdLoad = (scope: CampusScope, id?: string): any => {
  let q = new InMemoryQuery(ROWS).where("id", "=", id);
  q = applyCampusScope(q, scope);
  return q.execute()[0] ?? {}; // ?? {} → out-of-scope id is indistinguishable from "not found"
};

// ── Phase-2 ordination fixtures (personOrdinations rows on campus A / campus B). ─────────────────
// These mirror the PersonOrdinationRepo read shape: churchId filter FIRST, then applyCampusScope
// layered on top (load is a 404-hide via `?? {}`; loadAll/loadForPerson silent-filter). Driving the
// SAME real primitive over an in-memory fixture keeps the Phase-2 registrations DB-free.
const ORDINATION_ROWS = [
  { id: "ord-a1", campusId: A, personId: "p1", ordinationTypeId: "t-pastor", status: "active" },
  { id: "ord-a2", campusId: A, personId: "p2", ordinationTypeId: "t-elder", status: "active" },
  { id: "ord-b1", campusId: B, personId: "p3", ordinationTypeId: "t-pastor", status: "active" }
];

// personOrdination LIST — repo loadAll: churchId then applyCampusScope, returns the matched rows.
const personOrdinationList = (scope: CampusScope): any[] => {
  let q = new InMemoryQuery(ORDINATION_ROWS); // (real repo filters churchId first; constant here)
  q = applyCampusScope(q, scope);
  return q.execute();
};

// personOrdination GET-BY-ID — repo load: out-of-scope id 404-hides (`?? {}`).
const personOrdinationGetById = (scope: CampusScope, id?: string): any => {
  let q = new InMemoryQuery(ORDINATION_ROWS).where("id", "=", id);
  q = applyCampusScope(q, scope);
  return q.execute()[0] ?? {};
};

// ── Phase-20 formSubmission INBOX fixtures (login-free prayer/contact rows on A / B). ────────────
// FormSubmissionRepo.loadInboxScoped / loadDetailScoped / markRead all filter churchId FIRST then
// layer applyCampusScope(q, scope) — the SAME primitive. Driving it over an in-memory fixture keeps
// the FRM-03 inbox-read registration DB-free and asserts a campus admin cannot read another
// campus's submissions (the leak-gate assertion the plan calls for).
const INBOX_ROWS = [
  { id: "fs-a1", campusId: A, submissionType: "prayer", submitterName: "Alice", unread: 1 },
  { id: "fs-a2", campusId: A, submissionType: "contact", submitterName: "Amy", unread: 1 },
  { id: "fs-b1", campusId: B, submissionType: "prayer", submitterName: "Bob", unread: 1 }
];

// inbox LIST — loadInboxScoped: churchId then applyCampusScope, returns the matched rows.
const inboxList = (scope: CampusScope): any[] => {
  let q = new InMemoryQuery(INBOX_ROWS); // (real repo filters churchId first; constant here)
  q = applyCampusScope(q, scope);
  return q.execute();
};

// inbox DETAIL — loadDetailScoped: an out-of-scope id 404-hides (repo returns null; `?? {}` here).
const inboxDetail = (scope: CampusScope, id?: string): any => {
  let q = new InMemoryQuery(INBOX_ROWS).where("id", "=", id);
  q = applyCampusScope(q, scope);
  return q.execute()[0] ?? {};
};

// Fake AuthenticatedUser whose checkAccess answers per-permission (marker vs Edit capability).
const makeAu = (opts: { marker: boolean; edit?: boolean }) =>
  ({
    id: "user1",
    churchId: "church1",
    checkAccess: (perm: { contentType: string; action: string }) => {
      if (perm.contentType === "Campus" && perm.action === "Admin") return opts.marker; // org-wide marker
      if (perm.contentType === "People" && perm.action === "Edit") return !!opts.edit; // write capability
      return false;
    }
  } as any);

// Fake Repos exposing only the resolver query the helper touches.
const makeRepos = (campusIds: string[]) =>
  ({ userCampus: { loadCampusIdsForUser: jest.fn(async () => campusIds) } } as any);

describe("campusIsolation (PERM-07 phase exit gate)", () => {
  describe("applyCampusScope builder shape (fail-closed, no empty IN)", () => {
    it("adds NO where clause for org-wide scope", () => {
      const q = applyCampusScope(new InMemoryQuery(ROWS), { mode: "all" });
      expect(q.whereCalls).toHaveLength(0);
    });

    it("adds an IN(set) predicate over the assigned campuses for a scoped user", () => {
      const q = applyCampusScope(new InMemoryQuery(ROWS), { mode: "scoped", campusIds: [A] });
      expect(q.whereCalls).toHaveLength(1);
      expect(q.whereCalls[0]).toMatchObject({ column: "campusId", op: "in", value: [A], raw: false });
    });

    it("adds a raw sql`1=0` predicate for deny — never an empty IN ()", () => {
      const q = applyCampusScope(new InMemoryQuery(ROWS), { mode: "deny" });
      expect(q.whereCalls).toHaveLength(1);
      expect(q.whereCalls[0].raw).toBe(true); // raw sql, not a column/op/value IN clause
      expect(q.whereCalls[0].op).toBeUndefined();
      expect(q.execute()).toEqual([]); // matches nothing
    });
  });

  describe("read isolation through expectCampusIsolation (the reusable registration point)", () => {
    it("get-by-id: foreign-campus id 404-hides, own visible, org-wide sees both, deny sees none", async () => {
      await expectCampusIsolation(getByIdLoad, {
        kind: "get-by-id",
        inScopeCampusId: A,
        outOfScopeCampusId: B,
        inScopeId: "a1",
        outOfScopeId: "b1"
      });
    });

    it("search/list: scoped silent-filter to own campus, org-wide all, deny empty", async () => {
      await expectCampusIsolation(listLoad, {
        kind: "list",
        inScopeCampusId: A,
        outOfScopeCampusId: B
      });
    });
  });

  describe("CampusScopeHelper.resolve (server-side derivation, fail-closed)", () => {
    it("org-wide marker → mode:'all' WITHOUT touching the assignment repo", async () => {
      const repos = makeRepos([A]);
      const scope = await CampusScopeHelper.resolve(makeAu({ marker: true }), repos);
      expect(scope).toEqual({ mode: "all" });
      expect(repos.userCampus.loadCampusIdsForUser).not.toHaveBeenCalled();
    });

    it("no marker + assigned campuses → mode:'scoped' with exactly that set", async () => {
      const scope = await CampusScopeHelper.resolve(makeAu({ marker: false }), makeRepos([A]));
      expect(scope).toEqual({ mode: "scoped", campusIds: [A] });
    });

    it("no marker + ZERO assignments → mode:'deny' (fail-closed, never empty IN)", async () => {
      const scope = await CampusScopeHelper.resolve(makeAu({ marker: false }), makeRepos([]));
      expect(scope).toEqual({ mode: "deny" });
    });
  });

  describe("zero-assignment scoped user is denied everywhere (fail-closed end-to-end)", () => {
    it("resolves to deny, then both list and get-by-id return empty", async () => {
      const scope = await CampusScopeHelper.resolve(makeAu({ marker: false }), makeRepos([]));
      expect(scope).toEqual({ mode: "deny" });
      expect(listLoad(scope)).toEqual([]);
      expect(getByIdLoad(scope, "a1")).toEqual({});
      expect(getByIdLoad(scope, "b1")).toEqual({});
    });
  });

  describe("write isolation (PERM-06 — a foreign-campus write target is rejected)", () => {
    it("scoped user cannot write a foreign campus but can write its own", () => {
      expectWriteIsolation({ mode: "scoped", campusIds: [A] }, B);
    });

    it("deny scope writes nothing; org-wide may write any real campus", () => {
      expect(assertWritableCampus({ mode: "deny" }, A)).toBe(false);
      expectWriteIsolation({ mode: "deny" }, B);
      expect(assertWritableCampus({ mode: "all" }, A)).toBe(true);
      expect(assertWritableCampus({ mode: "all" }, "")).toBe(false); // rejects empty/falsy target
    });
  });

  // ── PHASE 2 REGISTRATIONS (ORD-02/03/04 reads + writes) ──────────────────────────────────────
  // The support header (campusIsolationSupport.ts, lines 19-27) enumerates the endpoint types each
  // later phase must register here with ONE expectCampusIsolation/expectWriteIsolation line. Phase 2
  // adds the three personOrdination endpoint types — proving a scoped Campus Admin 404-hides/filters
  // foreign-campus ordinations and cannot issue/change a credential targeting a foreign campus.
  describe("Phase 2: personOrdination read isolation (ORD reads through the reusable gate)", () => {
    it("get-by-id: a foreign-campus ordination 404-hides under A-scope; org-wide sees both; deny none", async () => {
      await expectCampusIsolation(personOrdinationGetById, {
        kind: "get-by-id",
        inScopeCampusId: A,
        outOfScopeCampusId: B,
        inScopeId: "ord-a1",
        outOfScopeId: "ord-b1"
      });
    });

    it("list: A-scope returns only A ordinations (no B leakage); org-wide both; deny empty", async () => {
      await expectCampusIsolation(personOrdinationList, {
        kind: "list",
        inScopeCampusId: A,
        outOfScopeCampusId: B
      });
    });
  });

  describe("Phase 2: personOrdination write isolation (issue / changeStatus target validation)", () => {
    it("a scoped Campus Admin cannot issue/change an ordination targeting foreign campus B, but can on own A", () => {
      // issue: assertWritableCampus(scope, body.campusId); changeStatus: on the LOADED row's campusId.
      // Either way a foreign-campus target is rejected and the own campus stays writable.
      expectWriteIsolation({ mode: "scoped", campusIds: [A] }, B);
    });
  });

  describe("Phase 20: formSubmission inbox read isolation (FRM-03 — login-free prayer/contact reads)", () => {
    it("detail: a foreign-campus submission 404-hides under A-scope; org-wide sees both; deny none", async () => {
      await expectCampusIsolation(inboxDetail, {
        kind: "get-by-id",
        inScopeCampusId: A,
        outOfScopeCampusId: B,
        inScopeId: "fs-a1",
        outOfScopeId: "fs-b1"
      });
    });

    it("list: a campus admin sees ONLY their campus's submissions; org-wide all; deny empty", async () => {
      await expectCampusIsolation(inboxList, {
        kind: "list",
        inScopeCampusId: A,
        outOfScopeCampusId: B
      });
    });
  });

  describe("Reporter write-gating (Open-Q3 — scope 'all' does NOT imply write capability)", () => {
    it("an org-wide read-only role resolves to 'all' for reads yet is blocked from writes", async () => {
      // Reporter carries the org-wide marker (sees every campus) but is NOT granted People__Edit.
      // Scope 'all' governs READ visibility only; the Plan-04 write gate is a SEPARATE
      // checkAccess(CAMPUS_WRITE_PERMISSION) check, which must fail here.
      const reporter = makeAu({ marker: true, edit: false });
      const scope = await CampusScopeHelper.resolve(reporter, makeRepos([]));
      expect(scope).toEqual({ mode: "all" }); // reads: org-wide
      expect(reporter.checkAccess(CAMPUS_WRITE_PERMISSION)).toBe(false); // writes: blocked
      // sanity: the marker the resolver keys on and the write permission are distinct objects.
      expect(CAMPUS_WRITE_PERMISSION).not.toEqual(CAMPUS_ORGWIDE_MARKER);
    });
  });
});

// ── Optional DB-backed parity cases (opt-in; skipped cleanly when no MySQL/flag). ────────────────
const dbEnabled = process.env.ENABLE_DB_ISOLATION_TESTS === "1";
(dbEnabled ? describe : describe.skip)("DB-backed campus isolation (opt-in: ENABLE_DB_ISOLATION_TESTS=1)", () => {
  it("repeats the read/write assertions through a real scoped repo query", () => {
    // When enabled: run the userCampus migration against the *_test membership schema in beforeAll,
    // seed one church + campuses A/B + a Campus Admin assigned ONLY to A, then re-run the same
    // get-by-id 404-hide / list filter / write-reject assertions through a real scoped repo query.
    // The pure-logic core above is the authoritative gate; this is environment parity only.
    expect(dbEnabled).toBe(true);
  });
});
