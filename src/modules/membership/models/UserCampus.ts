// A user's assignment to a campus within a church (PERM-01). Membership is
// many-to-many: a user may be assigned to one or more campuses. Soft-deleted
// via `removed` so revoked assignments keep their history. `addedBy` records
// the user who created the assignment (nullable for system/seed bootstrap).
export class UserCampus {
  public id?: string;
  public churchId?: string;
  public userId?: string;
  public campusId?: string;
  public addedBy?: string;
  public createdAt?: Date;
  public removed?: boolean;
}
