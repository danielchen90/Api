import { controller, httpGet, httpPost, requestParam } from "inversify-express-utils";
import express from "express";
import { MembershipBaseController } from "./MembershipBaseController.js";
import {
  CampusScopeHelper,
  assertWritableCampus,
  CAMPUS_WRITE_PERMISSION,
  AuditLogHelper,
  OrdinationStatusHelper
} from "../helpers/index.js";
import { PersonOrdination } from "../models/index.js";

/**
 * Person-ordination assignment API — the integrity core of Phase 2 (ORD-02/04/05/06/07/08).
 *
 * Reads resolve the caller's CampusScope server-side (CampusScopeHelper.resolve) and layer it
 * onto every query in the repo: an out-of-scope id is 404-hidden (load → null), lists are
 * silently filtered. Scope is NEVER read from the request (Pitfall 3).
 *
 * Writes (issue, changeStatus) enforce, in a FIXED order:
 *   1. WRITE-CAPABILITY GATE — au.checkAccess(CAMPUS_WRITE_PERMISSION) (read-only Viewer/Reporter
 *      401 even with the org-wide marker; the marker means scope, never write capability).
 *   2. SCOPE GATE — assertWritableCampus against the SERVER-derived scope. On issue this validates
 *      the body campusId (no widening); on changeStatus it validates the LOADED row's campusId
 *      (never trust a body campusId for an existing record — UserCampusController.remove pattern).
 *   3. TRANSITION VALIDATION (changeStatus only) — OrdinationStatusHelper.isValidTransition → 422.
 *   4. VERSION GUARD (changeStatus, ORD-07) — updateWithVersion returns 0n on stale version → 409
 *      { error: "version_conflict" }.
 *   5. DUPLICATE-ACTIVE (ORD-04) — the DB partial-unique index throws ER_DUP_ENTRY (errno 1062),
 *      surfaced as a DISTINCT 409 { error: "duplicate_active" } so the UI can say "already active"
 *      vs "record changed, reload".
 *   6. EXPLICIT AUDIT (ORD-08) — AuditLogHelper.log on every issue/reissue/revoke. BaseController
 *      auto-audit does NOT cover these routes (Pitfall 4), so the audit row is written explicitly.
 */
@controller("/membership/personOrdinations")
export class PersonOrdinationController extends MembershipBaseController {

  // MySQL duplicate-key on the ORD-04 partial-unique index (person+type+campus+activeFlag).
  private isDuplicateActive(err: any): boolean {
    return err?.code === "ER_DUP_ENTRY" || err?.errno === 1062;
  }

  // ── Scoped reads (scope FIRST, then query) ──

  // Get-by-id: out-of-scope / missing id is indistinguishable from "not found" (404-hide → null).
  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await CampusScopeHelper.resolve(au, this.repos);
      return this.repos.personOrdination.load(au.churchId, id, scope);
    });
  }

  // List — optional ?personId= narrows to one person's credentials (ORD-03). Both are scope-filtered.
  @httpGet("/")
  public async getAll(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await CampusScopeHelper.resolve(au, this.repos);
      const personId = req.query.personId as string | undefined;
      if (personId) return this.repos.personOrdination.loadForPerson(au.churchId, personId, scope);
      return this.repos.personOrdination.loadAll(au.churchId, scope);
    });
  }

  // ── Issue (ORD-02/04/06/08) — write-gated + scope-gated, dup-active → 409, audited ──
  @httpPost("/")
  public async issue(req: express.Request<{}, {}, PersonOrdination>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await CampusScopeHelper.resolve(au, this.repos);

      // 1. WRITE-CAPABILITY GATE first (read-only roles 401 even with the org-wide marker).
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      // 2. SCOPE GATE on the body campusId — a scoped caller cannot widen via the body (Pitfall 3).
      const item = req.body;
      if (!assertWritableCampus(scope, item.campusId)) return this.json({}, 401);

      // 3. Server-derive tenancy/attribution; default the status; accept nullable dates/number as-is (ORD-06).
      //    Never set activeFlag (DB-generated) or version (DB default = 1).
      item.churchId = au.churchId;
      item.createdBy = au.id;
      item.status = OrdinationStatusHelper.isValidStatus(item.status)
        ? item.status
        : OrdinationStatusHelper.DEFAULT_ISSUE_STATUS;

      // 4. Surface a duplicate-active insert (ORD-04) as a DISTINCT 409 from version_conflict.
      let saved: PersonOrdination;
      try {
        saved = await this.repos.personOrdination.save(item);
      } catch (err: any) {
        if (this.isDuplicateActive(err)) return this.json({ error: "duplicate_active" }, 409);
        throw err;
      }

      // 5. ORD-08 explicit audit (BaseController auto-audit does NOT cover ordination routes).
      await AuditLogHelper.log(
        this.repos, au.churchId, au.id, "ordination", "credential_issued",
        "personOrdination", saved.id,
        { status: saved.status, credentialNumber: saved.credentialNumber, ordinationTypeId: saved.ordinationTypeId, campusId: saved.campusId },
        AuditLogHelper.getClientIp(req)
      );
      return saved;
    });
  }

  // ── Status change / reissue / revoke (ORD-05/07/08) ──
  //
  // ONE version-guarded, transition-validated, audited endpoint covers the whole lifecycle
  // (revoke and reissue are just status targets — no separate routes). Guard order is FIXED:
  // write gate -> load row SCOPED -> assertWritableCampus(row.campusId) -> transition 422 ->
  // version 409 / duplicate-active 409 -> audit -> return the bumped row.
  @httpPost("/:id/status")
  public async changeStatus(
    @requestParam("id") id: string,
    req: express.Request<{ id: string }, {}, { status: string; version: number; credentialNumber?: string; grantedDate?: Date; expirationDate?: Date; notes?: string }>,
    res: express.Response
  ): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await CampusScopeHelper.resolve(au, this.repos);

      // 1. WRITE-CAPABILITY GATE first (read-only roles 401 even with the org-wide marker).
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      // 2. Load the row SCOPED — out-of-scope or missing is a 404-hide (never reveal cross-campus rows).
      const row = await this.repos.personOrdination.load(au.churchId, id, scope);
      if (!row?.id) return this.json({}, 404);

      // 3. SCOPE GATE on the LOADED row's campusId — never trust a body campusId for an existing record.
      if (!assertWritableCampus(scope, row.campusId)) return this.json({}, 401);

      // 4. TRANSITION VALIDATION (ORD-05): unknown target or disallowed edge → 422.
      const body = req.body;
      if (!OrdinationStatusHelper.isValidStatus(body.status)) return this.json({ error: "invalid_status" }, 422);
      if (!OrdinationStatusHelper.isValidTransition(row.status as any, body.status)) return this.json({ error: "invalid_transition" }, 422);

      // 5. VERSION-GUARDED UPDATE (ORD-07). Missing fields fall back to the loaded row's values.
      //    A transition TO active can trip the ORD-04 unique index → distinct 409 duplicate_active.
      let n: bigint;
      try {
        n = await this.repos.personOrdination.updateWithVersion({
          id,
          churchId: au.churchId,
          status: body.status,
          credentialNumber: body.credentialNumber ?? row.credentialNumber,
          grantedDate: body.grantedDate ?? row.grantedDate,
          expirationDate: body.expirationDate ?? row.expirationDate,
          notes: body.notes ?? row.notes,
          updatedBy: au.id
        }, body.version);
      } catch (err: any) {
        if (this.isDuplicateActive(err)) return this.json({ error: "duplicate_active" }, 409);
        throw err;
      }
      if (n === 0n) return this.json({ error: "version_conflict" }, 409); // stale version / row gone (Pitfall 2)

      // 6. EXPLICIT AUDIT (ORD-08): revoke vs reissue distinguished by the target status.
      const action = body.status === "revoked" ? "credential_revoked" : "credential_reissued";
      await AuditLogHelper.log(
        this.repos, au.churchId, au.id, "ordination", action,
        "personOrdination", id, { from: row.status, to: body.status },
        AuditLogHelper.getClientIp(req)
      );

      // 7. Return the reloaded row (carries the bumped version for the client's next edit).
      return this.repos.personOrdination.load(au.churchId, id, scope);
    });
  }

  // ── Payment flags (paid / exempt) — write-gated + scope-gated, version-guarded, audited ──
  //
  // Dedicated write path so a payment edit never clobbers status/grant/expiry (updatePaymentFlags
  // touches ONLY paid/exempt + version). Same fixed guard order as changeStatus: write gate ->
  // load SCOPED -> assertWritableCampus(row.campusId) -> version 409 -> audit -> reload.
  @httpPost("/:id/payment")
  public async updatePayment(
    @requestParam("id") id: string,
    req: express.Request<{ id: string }, {}, { paid?: boolean; exempt?: boolean; version: number }>,
    res: express.Response
  ): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await CampusScopeHelper.resolve(au, this.repos);

      // 1. WRITE-CAPABILITY GATE first (read-only roles 401 even with the org-wide marker).
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      // 2. Load the row SCOPED — out-of-scope or missing is a 404-hide.
      const row = await this.repos.personOrdination.load(au.churchId, id, scope);
      if (!row?.id) return this.json({}, 404);

      // 3. SCOPE GATE on the LOADED row's campusId — never trust a body campusId for an existing record.
      if (!assertWritableCampus(scope, row.campusId)) return this.json({}, 401);

      // 4. Missing flags fall back to the loaded row's current values (partial update).
      const body = req.body;
      const paid = body.paid ?? row.paid ?? false;
      const exempt = body.exempt ?? row.exempt ?? false;

      // 5. VERSION-GUARDED UPDATE (ORD-07).
      const n = await this.repos.personOrdination.updatePaymentFlags({ id, churchId: au.churchId, paid, exempt, updatedBy: au.id }, body.version);
      if (n === 0n) return this.json({ error: "version_conflict" }, 409); // stale version / row gone (Pitfall 2)

      // 6. EXPLICIT AUDIT (ORD-08).
      await AuditLogHelper.log(
        this.repos, au.churchId, au.id, "ordination", "credential_payment_updated",
        "personOrdination", id, { paid, exempt }, AuditLogHelper.getClientIp(req)
      );

      // 7. Return the reloaded row (carries the bumped version for the client's next edit).
      return this.repos.personOrdination.load(au.churchId, id, scope);
    });
  }

  // ── Batch grant (issue-in-bulk) — write-gated + per-row scope-gated, per-row audited ──
  //
  // Two literal path segments ("batch"/"grant") so this route does NOT collide with "/:id/...".
  // Each id is loaded SCOPED and campus-checked independently; non-fatal per-row outcomes are
  // collected in `skipped` (not_found / forbidden / version_conflict / duplicate_active) so one
  // bad id never aborts the batch. Each successful grant is a version-guarded active transition.
  @httpPost("/batch/grant")
  public async batchGrant(
    req: express.Request<{}, {}, { ids: string[]; grantedDate: string; expirationDate: string }>,
    res: express.Response
  ): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const scope = await CampusScopeHelper.resolve(au, this.repos);

      // 1. WRITE-CAPABILITY GATE first (read-only roles 401 even with the org-wide marker).
      if (!au.checkAccess(CAMPUS_WRITE_PERMISSION)) return this.json({}, 401);

      // 2. Validate the batch envelope.
      const body = req.body;
      if (!Array.isArray(body.ids) || body.ids.length === 0 || !body.grantedDate || !body.expirationDate) {
        return this.json({ error: "invalid_request" }, 422);
      }

      let granted = 0;
      const skipped: { id: string; reason: string }[] = [];

      for (const id of [...new Set(body.ids)]) {
        // Load SCOPED — out-of-scope / missing id is a non-fatal skip (never reveal cross-campus rows).
        const row = await this.repos.personOrdination.load(au.churchId, id, scope);
        if (!row?.id) { skipped.push({ id, reason: "not_found" }); continue; }
        if (!assertWritableCampus(scope, row.campusId)) { skipped.push({ id, reason: "forbidden" }); continue; }

        try {
          const n = await this.repos.personOrdination.updateWithVersion({
            id: row.id, churchId: au.churchId, status: "active",
            credentialNumber: row.credentialNumber,
            grantedDate: body.grantedDate as any, expirationDate: body.expirationDate as any,
            notes: row.notes, updatedBy: au.id
          }, row.version);
          if (n === 0n) { skipped.push({ id, reason: "version_conflict" }); continue; }
          granted++;
          await AuditLogHelper.log(this.repos, au.churchId, au.id, "ordination", "credential_granted", "personOrdination", id, { grantedDate: body.grantedDate, expirationDate: body.expirationDate }, AuditLogHelper.getClientIp(req));
        } catch (err: any) {
          if (this.isDuplicateActive(err)) { skipped.push({ id, reason: "duplicate_active" }); continue; }
          throw err;
        }
      }

      return { granted, skipped };
    });
  }
}
