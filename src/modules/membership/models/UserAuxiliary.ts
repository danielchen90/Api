// Assigns a user as a "president" of an auxiliary — the persisted set the
// AuxiliaryScopeHelper reads to scope cross-campus auxiliary reads.
export class UserAuxiliary {
  public id?: string;
  public churchId?: string;
  public userId?: string;
  public auxiliaryId?: string;
  public addedBy?: string;
  public createdAt?: Date;
  public removed?: boolean;
}
