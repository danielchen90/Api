// AUD-09 — a reusable NAMED audience DESCRIPTOR (Phase 10, Plan 04). Stores ONLY
// label + audienceType + targetId + filterJson (the raw descriptor string),
// NEVER a resolved person list — so it is re-scoped to the CURRENT caller at run
// time. Mirrors the 2026-07-09_saved_audiences.ts columns; `removed` is a
// boolean (bit(1)), `filterJson` a RAW string, `createdAt` a Date.
export class SavedAudience {
  public id?: string;
  public churchId?: string;
  public label?: string;
  public audienceType?: string;
  public targetId?: string;
  public filterJson?: string;
  public createdAt?: Date;
  public createdBy?: string;
  public removed?: boolean;
}
