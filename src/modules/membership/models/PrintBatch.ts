// PRT-02 batch-render entity: a reproducible, poll-able print batch. It captures
// the provenance (`filterJson` — the LOCKED "store BOTH" audit decision: the
// filter that produced the batch, alongside the resolved licenseCards rows), the
// render progress (`status` + DB-backed `renderedCount`/`cardCount`), the
// per-person skips (`skippedJson` — [{personId, reason}]), and the assembled-PDF
// FileStorage key (`pdfRef`).
//
//   - `status`         building | rendering | ready | failed.
//   - `cardCount`      denominator — the total cards queued for the batch.
//   - `renderedCount`  DB-backed progress numerator (bumped per card during
//                      render so a concurrent poller reads live progress).
//   - `pdfRef`         FileStorage key of the assembled multi-card PDF.
//   - `createdBy`      the actor (userId) who launched the batch.
//
// `cardCount`/`renderedCount` are int in MySQL and `removed` is bit(1); the repo
// coerces them (number / boolean) in rowToModel, so the model always carries
// plain types.
export class PrintBatch {
  public id?: string;
  public churchId?: string;
  public name?: string;
  public filterJson?: string;
  public status?: string;
  public cardCount?: number;
  public renderedCount?: number;
  public skippedJson?: string;
  public pdfRef?: string;
  public createdAt?: Date;
  public createdBy?: string;
  public removed?: boolean;
}
