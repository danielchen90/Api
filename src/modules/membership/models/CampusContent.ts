// A row of per-campus public-website content (CMS-01). One row per
// (churchId, campusId, contentType):
//   - campusId NULL  = the ORG DEFAULT for this contentType.
//   - campusId set   = that campus's SPARSE override (only changed fields stored),
//                      so an org-default change propagates live to any field the
//                      campus has not overridden (CampusContentResolver merges the
//                      two field-by-field).
//
// `content` is the serialized declarative JSON blob (read/edited as a string; the
// repo JSON.stringify's on write and JSON.parse's on read into a typed shape). It
// is stored SPARSE for campus overrides — an absent field means "inherit the org
// default".
//
// `version` is the OCC guard backing CampusContentRepo.updateWithVersion
// (optimistic concurrency, exactly like personOrdinations.version /
// licenseTemplates.version). A stale expectedVersion → numUpdatedRows 0n → the
// controller returns 409.
//
// NOTE: the DB also carries a STORED generated `campusKey` column (read-only,
// DB-computed: COALESCE(campusId,'~ORG~')) that backs the NULL-safe org-default
// unique index. It is intentionally NOT modeled here — the app never sets it and
// the repo never surfaces it.
export class CampusContent {
  public id?: string;
  public churchId?: string;
  public campusId?: string | null;
  public contentType?: string;
  public content?: string;
  public version?: number;
  public createdAt?: Date;
  public updatedAt?: Date;
}
