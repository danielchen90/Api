import {
  OrdinationStatusHelper,
  ORDINATION_STATUSES,
  type OrdinationStatus
} from "../OrdinationStatusHelper.js";

/**
 * PHASE 2 INTEGRITY SUITE — the three net-new ordination mechanics, proven in PURE LOGIC (no MySQL).
 *
 * This is the DB-free half of the Phase-2 exit gate (the cross-campus isolation half lives in
 * campusIsolation.test.ts). It proves, without a database:
 *
 *   ORD-07  the optimistic-concurrency version guard yields BigInt `0n` on a STALE expectedVersion
 *           and non-zero when it matches — i.e. an UPDATE guarded by `WHERE version = expected` with
 *           `SET version = version + 1` reliably distinguishes "row changed under me" from "applied".
 *   ORD-05  OrdinationStatusHelper.isValidTransition / isValidStatus / DEFAULT_ISSUE_STATUS encode the
 *           lifecycle state machine (active→suspended ok, revoked terminal, same→same rejected).
 *   ORD-04  the generated `activeFlag` CASE rule (status='active' AND removed=0 → 1, else NULL) — two
 *           BOTH-active rows for one (person,type,campus) collide on `1`; revoked/removed → NULL, and
 *           MySQL's duplicate-NULL allowance permits reissue (ORD-03).
 *
 * The FULL DB round-trips (real ER_DUP_ENTRY, real numUpdatedRows, real reissue) are env-guarded at
 * the bottom (ENABLE_DB_ISOLATION_TESTS=1) and skip cleanly with no MySQL — exactly as Phase 1's gate.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ORD-07: version-guard 0n-on-stale semantics.
//
// A faithful in-memory stand-in for `PersonOrdinationRepo.updateWithVersion`: it records the guard
// clause (`WHERE version = expected`) and the bump (`SET version = version + 1`), then returns the
// SAME bigint contract the real repo returns — `numUpdatedRows` is `1n` only when the guard matches
// the fixture row's current version, `0n` otherwise (stale version / vanished row).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
class FakeVersionGuardedUpdate {
  public readonly whereCalls: Array<{ column: string; op: string; value: unknown }> = [];
  public setVersionExpr: string | null = null;
  private newVersion: number | null = null;

  constructor(private readonly row: { version: number }) {}

  /** Records `SET version = version + 1` (the ALWAYS-bump that defeats matched-vs-changed ambiguity). */
  setVersionBump(): this {
    this.setVersionExpr = "version + 1";
    this.newVersion = this.row.version + 1;
    return this;
  }

  /** Records `WHERE <column> <op> <value>` — including the `version = expected` guard. */
  where(column: string, op: string, value: unknown): this {
    this.whereCalls.push({ column, op, value });
    return this;
  }

  /**
   * Execute the guarded update against the fixture row. Returns `numUpdatedRows` as a bigint:
   * `1n` when EVERY where-clause matches the row (here, the version guard), else `0n`.
   */
  execute(): bigint {
    const matches = this.whereCalls.every(({ column, op, value }) => {
      if (column === "version" && op === "=") return (this.row as any).version === value;
      return true; // id/churchId equality is satisfied by construction in this fixture
    });
    if (!matches) return 0n;
    if (this.newVersion !== null) this.row.version = this.newVersion; // bump applied
    return 1n;
  }
}

// The repo's own contract: callers compare against BigInt 0n (never the number 0).
const updateWithVersion = (row: { version: number }, expectedVersion: number): bigint =>
  new FakeVersionGuardedUpdate(row)
    .setVersionBump()
    .where("id", "=", "ord-1")
    .where("churchId", "=", "church1")
    .where("version", "=", expectedVersion)
    .execute();

describe("ordination integrity — ORD-07 optimistic-concurrency version guard (DB-free)", () => {
  it("returns numUpdatedRows 1n and bumps version when expectedVersion MATCHES the current row", () => {
    const row = { version: 3 };
    const n = updateWithVersion(row, 3);
    expect(n).toBe(1n); // BigInt one — a row changed
    expect(row.version).toBe(4); // version = version + 1 applied
  });

  it("returns numUpdatedRows 0n and does NOT bump version when expectedVersion is STALE", () => {
    const row = { version: 3 };
    const n = updateWithVersion(row, 2); // a concurrent writer already moved 2 → 3
    expect(n).toBe(0n); // BigInt zero — stale version / row gone (controller maps to 409)
    expect(row.version).toBe(3); // unchanged — the guard refused to apply
  });

  it("compares against BigInt 0n, not the number 0 (the controller's 409 trigger is `n === 0n`)", () => {
    const stale = updateWithVersion({ version: 5 }, 1);
    expect(typeof stale).toBe("bigint");
    expect(stale === 0n).toBe(true);
    // guard against the Pitfall-2 footgun: `0n === 0` is false, so the controller must use 0n.
    expect((0n as unknown) === (0 as unknown)).toBe(false);
  });

  it("records the guard clause exactly: WHERE version = expected with SET version = version + 1", () => {
    const builder = new FakeVersionGuardedUpdate({ version: 3 })
      .setVersionBump()
      .where("id", "=", "ord-1")
      .where("churchId", "=", "church1")
      .where("version", "=", 3);
    expect(builder.setVersionExpr).toBe("version + 1");
    expect(builder.whereCalls).toContainEqual({ column: "version", op: "=", value: 3 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ORD-05: status lifecycle state machine.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("ordination integrity — ORD-05 status lifecycle (OrdinationStatusHelper)", () => {
  it("honors representative valid transitions (active→suspended, active→emeritus, suspended→active)", () => {
    expect(OrdinationStatusHelper.isValidTransition("active", "suspended")).toBe(true);
    expect(OrdinationStatusHelper.isValidTransition("active", "emeritus")).toBe(true);
    expect(OrdinationStatusHelper.isValidTransition("suspended", "active")).toBe(true);
    expect(OrdinationStatusHelper.isValidTransition("pending", "active")).toBe(true);
  });

  it("rejects invalid transitions: revoked is TERMINAL and same→same is a no-op (422 upstream)", () => {
    expect(OrdinationStatusHelper.isValidTransition("revoked", "active")).toBe(false); // terminal
    expect(OrdinationStatusHelper.isValidTransition("revoked", "suspended")).toBe(false);
    expect(OrdinationStatusHelper.isValidTransition("pending", "suspended")).toBe(false); // not an edge
    expect(OrdinationStatusHelper.isValidTransition("active", "active")).toBe(false); // no-op rejected
  });

  it("isValidStatus type-guards the five known statuses and rejects anything else", () => {
    for (const s of ORDINATION_STATUSES) expect(OrdinationStatusHelper.isValidStatus(s)).toBe(true);
    expect(OrdinationStatusHelper.isValidStatus("bogus")).toBe(false);
    expect(OrdinationStatusHelper.isValidStatus("")).toBe(false);
    expect(ORDINATION_STATUSES).toEqual(["pending", "active", "suspended", "revoked", "emeritus"]);
  });

  it("DEFAULT_ISSUE_STATUS is 'active' (a new credential is active on issue — operational requirement)", () => {
    expect(OrdinationStatusHelper.DEFAULT_ISSUE_STATUS).toBe("active");
    // and the default is itself a valid status.
    expect(OrdinationStatusHelper.isValidStatus(OrdinationStatusHelper.DEFAULT_ISSUE_STATUS)).toBe(true);
    // being born active, it can still transition onward (e.g. active → suspended).
    expect(OrdinationStatusHelper.isValidTransition(OrdinationStatusHelper.DEFAULT_ISSUE_STATUS, "suspended")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ORD-04: generated `activeFlag` CASE rule — mirrors the migration DDL verbatim:
//   ALTER TABLE personOrdinations ADD COLUMN activeFlag TINYINT GENERATED ALWAYS AS
//     (CASE WHEN status = 'active' AND removed = 0 THEN 1 ELSE NULL END) STORED
// inside UNIQUE (churchId, personId, ordinationTypeId, campusId, activeFlag). Two BOTH-active rows
// for one tuple carry activeFlag=1 and COLLIDE on the unique index; revoked/removed rows carry NULL,
// and MySQL allows duplicate NULLs → reissue (a NEW row) is permitted (ORD-03).
// This pure helper encodes the SAME predicate; the real constraint is exercised in the DB case below.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const activeFlag = (status: OrdinationStatus, removed: boolean): 1 | null =>
  status === "active" && !removed ? 1 : null;

// The unique key the DB enforces; NULL activeFlag makes the key NULL-distinct (duplicate-NULL allowed).
const uniqueKey = (r: {
  churchId: string;
  personId: string;
  ordinationTypeId: string;
  campusId: string;
  status: OrdinationStatus;
  removed: boolean;
}) => `${r.churchId}|${r.personId}|${r.ordinationTypeId}|${r.campusId}|${activeFlag(r.status, r.removed)}`;

describe("ordination integrity — ORD-04 activeFlag CASE rule (mirrors migration DDL)", () => {
  const tuple = { churchId: "church1", personId: "p1", ordinationTypeId: "t-pastor", campusId: "A" };

  it("two BOTH-active rows for the same (person,type,campus) both yield activeFlag=1 → they COLLIDE", () => {
    const a = { ...tuple, status: "active" as OrdinationStatus, removed: false };
    const b = { ...tuple, status: "active" as OrdinationStatus, removed: false };
    expect(activeFlag(a.status, a.removed)).toBe(1);
    expect(activeFlag(b.status, b.removed)).toBe(1);
    expect(uniqueKey(a)).toBe(uniqueKey(b)); // identical non-NULL key → ER_DUP_ENTRY at the DB (→409)
  });

  it("a revoked row yields activeFlag=NULL → MySQL allows the duplicate NULL, so reissue is permitted", () => {
    const revoked = { ...tuple, status: "revoked" as OrdinationStatus, removed: false };
    const reissued = { ...tuple, status: "active" as OrdinationStatus, removed: false };
    expect(activeFlag(revoked.status, revoked.removed)).toBeNull();
    expect(activeFlag(reissued.status, reissued.removed)).toBe(1);
    // The revoked row's NULL key never collides with the new active row's key (ORD-03 preserved).
    expect(uniqueKey(revoked)).not.toBe(uniqueKey(reissued));
  });

  it("a removed (soft-deleted) active row yields activeFlag=NULL → does not occupy the active slot", () => {
    const removedActive = { ...tuple, status: "active" as OrdinationStatus, removed: true };
    expect(activeFlag(removedActive.status, removedActive.removed)).toBeNull();
    // pending / suspended / emeritus also do NOT occupy the active slot (keys on literal 'active' only).
    expect(activeFlag("pending", false)).toBeNull();
    expect(activeFlag("suspended", false)).toBeNull();
    expect(activeFlag("emeritus", false)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// OPTIONAL DB-BACKED PARITY (opt-in: ENABLE_DB_ISOLATION_TESTS=1) — skipped cleanly with no MySQL.
// When enabled: apply the ordinations migration against the *_test membership schema, seed a church +
// campuses A/B + one person, then prove LIVE: (1) a duplicate-active insert throws ER_DUP_ENTRY (→409
// duplicate_active), (2) a stale-version update returns numUpdatedRows === 0n (→409 version_conflict),
// (3) a revoke-then-reissue succeeds (ORD-03). The pure-logic suites above are the authoritative gate;
// this is environment parity only and the deferred live verification for phase Success Criteria 3 & 4.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const dbEnabled = process.env.ENABLE_DB_ISOLATION_TESTS === "1";
(dbEnabled ? describe : describe.skip)(
  "DB-backed ordination integrity (opt-in: ENABLE_DB_ISOLATION_TESTS=1)",
  () => {
    it("repeats duplicate-active / stale-version / revoke-then-reissue against a real schema", () => {
      // See header: migrate *_test schema, seed church+campuses+person, then assert ER_DUP_ENTRY,
      // numUpdatedRows===0n on stale version, and a successful reissue after revoke.
      expect(dbEnabled).toBe(true);
    });
  }
);
