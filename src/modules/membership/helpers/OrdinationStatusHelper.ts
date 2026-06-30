/**
 * Ordination status lifecycle state machine (ORD-05).
 *
 * The single source of truth for the credential-status vocabulary and the allowed
 * transitions between states. `PersonOrdinationController.changeStatus` (02-04)
 * validates every status mutation through `isValidTransition` and returns 422 on a
 * violation — so an "active → emeritus" is honored while a nonsensical
 * "revoked → active" is rejected at the API boundary.
 *
 * `revoked` is TERMINAL: there are no outgoing edges. Re-credentialing a revoked
 * minister does NOT mutate the revoked row — it creates a NEW personOrdinations row,
 * which the ORD-04 partial-unique index permits because the revoked row's generated
 * `activeFlag` is NULL (MySQL allows duplicate NULLs). This keeps the audit trail
 * append-only: a revocation stays revoked forever.
 */
export type OrdinationStatus = "pending" | "active" | "suspended" | "revoked" | "emeritus";

/**
 * All five statuses, for validation (`isValidStatus`) and UI pickers.
 */
export const ORDINATION_STATUSES: OrdinationStatus[] = ["pending", "active", "suspended", "revoked", "emeritus"];

/**
 * Allowed-transitions map (RESEARCH recommendation). A status may move ONLY to a
 * state listed in its array. `revoked` maps to `[]` — terminal, no outgoing edges.
 * Same → same is NOT listed anywhere, so `isValidTransition` rejects no-op changes
 * (a status POST that does not change the status is a 422, not a silent success).
 */
const ALLOWED_TRANSITIONS: Record<OrdinationStatus, OrdinationStatus[]> = {
  pending: ["active", "revoked"],
  active: ["suspended", "revoked", "emeritus"],
  suspended: ["active", "revoked", "emeritus"],
  emeritus: ["active", "revoked"],
  revoked: [] // terminal — re-credentialing creates a NEW row (ORD-04 NULL-distinctness)
};

export class OrdinationStatusHelper {
  /**
   * Issue default (RESEARCH-recommended): a new credential starts `pending`, then is
   * explicitly activated. Issuing-then-activating yields a clean two-step audit trail
   * (credential_issued → credential_reissued) rather than springing into `active`.
   */
  public static readonly DEFAULT_ISSUE_STATUS: OrdinationStatus = "pending";

  /** Type guard — is the raw string one of the five known statuses? */
  public static isValidStatus(s: string): s is OrdinationStatus {
    return (ORDINATION_STATUSES as string[]).includes(s);
  }

  /**
   * Is `from → to` an allowed lifecycle transition? Reads the map; an unknown `from`
   * or a `to` not in `from`'s edge list (including same → same) returns false.
   */
  public static isValidTransition(from: OrdinationStatus, to: OrdinationStatus): boolean {
    return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
  }
}
