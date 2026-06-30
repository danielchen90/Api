// The live/current row of a CR80 ministerial-license card template (TPL-03,
// TPL-04). `layoutJson` is the serialized declarative layout (read/edited as a
// string). `ordinationTypeId` NULL = a global default that applies to all types;
// non-null = a per-type binding. `isDefault`/`active`/`removed` are bit(1) in the
// DB and coerced to booleans by the repo's rowToModel.
//
// TWO DISTINCT version concepts (RESEARCH Pitfall 4 — do NOT conflate):
//   - `currentVersion` is the CONTENT/AUDIT version: it bumps on every save and
//     is mirrored into licenseTemplateVersions.versionNumber.
//   - `version` is the OCC guard backing updateWithVersion (optimistic
//     concurrency), exactly like personOrdinations.version.
//
// NOTE: the DB also carries STORED generated `defaultFlag`/`activeFlag` columns
// (read-only, DB-computed) that back the single-global-default and one-active-
// per-type unique indexes. They are intentionally NOT modeled here — the app must
// never attempt to set them, and rowToModel never surfaces them.
export class LicenseTemplate {
  public id?: string;
  public churchId?: string;
  public name?: string;
  public ordinationTypeId?: string;
  public isDefault?: boolean;
  public active?: boolean;
  public layoutJson?: string;
  public currentVersion?: number;
  public version?: number;
  public removed?: boolean;
  public createdAt?: Date;
  public createdBy?: string;
  public updatedAt?: Date;
  public updatedBy?: string;
}
