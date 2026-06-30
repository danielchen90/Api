// PHO-04 normalized license-crop TRANSFORM for a person's stored member photo.
//
// Instead of a second cropped image file, this row persists a tiny normalized
// rect (cropX/Y/Width/Height each in 0..1 of the source image) plus an optional
// `rotation` in degrees. Phase 6 re-applies the transform to the single stored
// member photo to render the CR80 card photo at any output resolution.
//
// `purpose` (default 'license') is the upsert discriminator — UNIQUE
// (churchId, personId, purpose) means exactly one license crop per person.
// `sourceUpdated` records person.photoUpdated at crop time so a stale crop (the
// underlying photo changed afterwards) can be detected downstream.
//
// Crop fields are stored as decimal(7,5) in MySQL (returned as strings by the
// driver) — the repo coerces them back to numbers in rowToModel, so the model
// always carries plain numbers.
export class PersonPhotoCrop {
  public id?: string;
  public churchId?: string;
  public personId?: string;
  public purpose?: string;
  public cropX?: number;
  public cropY?: number;
  public cropWidth?: number;
  public cropHeight?: number;
  public rotation?: number;
  public sourceUpdated?: Date;
  public createdAt?: Date;
  public createdBy?: string;
  public updatedAt?: Date;
  public updatedBy?: string;
  public removed?: boolean;
}
