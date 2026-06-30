// A church-wide ordination type (ORD-01): the controlled vocabulary of
// credentials a church can grant (Bishop, Pastor, Elder, ...). NOT campus-scoped
// — types are defined once per church and referenced by campus-scoped
// personOrdinations rows.
//
// `active` is the product-level toggle: a deactivated type is no longer offered
// for new grants but remains valid vocabulary for existing/historical rows.
// `removed` is the engineering soft delete (tombstone) — distinct from `active`.
// `sortOrder` encodes the seniority/display ranking. `code` is unique per church
// and is the seed idempotency key.
export class OrdinationType {
  public id?: string;
  public churchId?: string;
  public name?: string;
  public code?: string;
  public sortOrder?: number;
  public description?: string;
  public active?: boolean;
  public removed?: boolean;
  public createdAt?: Date;
}
