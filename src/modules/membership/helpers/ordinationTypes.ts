/**
 * Starter ordination vocabulary (ORD-01) — the SINGLE source of truth for the
 * seed in 02-03. A church gets these six types on bootstrap; admins may add,
 * deactivate, or re-order them afterward.
 *
 * `code` is the per-church unique key (seed idempotency: upsert-by-code).
 * `sortOrder` encodes a seniority ordering (Bishop highest); it is adjustable
 * and need not be contiguous. The roadmap lists Pastor, Elder, Deacon, Minister,
 * Bishop, Evangelist — all six are represented here.
 */
export const STARTER_ORDINATION_TYPES = [
  { name: "Bishop", code: "BISHOP", sortOrder: 10 },
  { name: "Pastor", code: "PASTOR", sortOrder: 20 },
  { name: "Elder", code: "ELDER", sortOrder: 30 },
  { name: "Minister", code: "MINISTER", sortOrder: 40 },
  { name: "Evangelist", code: "EVANGELIST", sortOrder: 50 },
  { name: "Deacon", code: "DEACON", sortOrder: 60 }
] as const;
