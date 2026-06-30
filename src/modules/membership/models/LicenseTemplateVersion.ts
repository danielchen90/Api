// An immutable audit-grade snapshot of a license template's layout at a given
// version (TPL-03). Written once per save (versionNumber === the parent
// licenseTemplates.currentVersion at that save) and never updated — this is the
// reproduce-an-old-card record Phase 6 reads. Keyed UNIQUE(churchId, templateId,
// versionNumber) at the DB.
export class LicenseTemplateVersion {
  public id?: string;
  public churchId?: string;
  public templateId?: string;
  public versionNumber?: number;
  public layoutJson?: string;
  public createdAt?: Date;
  public createdBy?: string;
}
