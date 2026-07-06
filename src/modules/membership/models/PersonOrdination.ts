// A campus-scoped assignment of an ordination type to a person (ORD-02..04, 06,
// 07). One person may hold several distinct ordinations and may be re-issued the
// same one after a prior grant is revoked.
//
// `status` (ORD-05) is the lifecycle state (e.g. "active", "revoked",
// "suspended"), stored as a plain string. `version` (ORD-07) is the
// optimistic-concurrency counter, bumped on every write. `grantedDate` and
// `expirationDate` (ORD-06) are nullable calendar dates.
//
// NOTE: the DB also carries a STORED generated `activeFlag` column (NULL unless
// status='active' AND removed=0) that backs the ORD-04 partial-unique index. It
// is intentionally NOT modeled here — it is read-only and DB-computed, so the
// app must never attempt to set it. Repos cast it away when needed.
export class PersonOrdination {
  public id?: string;
  public churchId?: string;
  public campusId?: string;
  public personId?: string;
  public ordinationTypeId?: string;
  public status?: string;
  public credentialNumber?: string;
  public grantedDate?: Date;
  public expirationDate?: Date;
  public version?: number;
  public notes?: string;
  public paid?: boolean;
  public exempt?: boolean;
  public createdAt?: Date;
  public createdBy?: string;
  public updatedAt?: Date;
  public updatedBy?: string;
  public removed?: boolean;
}
