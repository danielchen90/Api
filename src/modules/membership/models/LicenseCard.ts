// PRT-03 print-audit row for a CONFIRMED print of a CR80 ministerial-license
// card (written by Plan 06-04's confirm endpoint). This is a first-class,
// queryable, campus-scoped domain audit row — NOT a generic AuditLog blob — so
// "who printed which person's which credential, on what template version, and
// here's the exact archived PDF" is directly answerable and campus-scoped.
//
//   - `personId`            the member whose card was printed.
//   - `personOrdinationId`  the specific credential printed.
//   - `campusId`            campus-scoped like ordinations (audit/reporting).
//   - `templateId`          the licenseTemplate used.
//   - `templateVersion`     licenseTemplate.currentVersion AT PRINT TIME (the
//                           exact rendered layout is reproducible via
//                           licenseTemplateVersions).
//   - `pdfRef`              FileStorage key of the archived PDF blob.
//   - `createdBy`           the actor (userId) who confirmed the print.
//
// This is an APPEND-ONLY audit row: no OCC/version column, no campus-scope
// mechanics in the model — the controller applies CampusScope on write.
// `templateVersion` is int in MySQL and `removed` is bit(1); the repo coerces
// them (number / boolean) in rowToModel, so the model always carries plain types.
//
// Phase-7 lifecycle extension (PRT-02 / PRT-04): `batchId` links a card to its
// printBatch (null for Phase-6 single prints); `status` drives the
// draft/queued/printed/reissued/void lifecycle (existing rows default to
// "printed"); `printedAt`/`voidReason`/`voidedAt`/`voidedBy` stamp the print and
// void events. All optional so Phase-6 single-print rows are untouched.
export class LicenseCard {
  public id?: string;
  public churchId?: string;
  public personId?: string;
  public personOrdinationId?: string;
  public campusId?: string;
  public templateId?: string;
  public templateVersion?: number;
  public pdfRef?: string;
  public createdAt?: Date;
  public createdBy?: string;
  public removed?: boolean;
  public batchId?: string;
  public sortOrder?: number; // card index within its batch → deterministic, page-aligned loadByBatch order
  public status?: string;
  public printedAt?: Date;
  public voidReason?: string;
  public voidedAt?: Date;
  public voidedBy?: string;
}
