// A church-wide auxiliary (program/ministry) that spans campuses. Its per-campus
// instances are groups carrying this auxiliary's id in groups.auxiliaryId.
export class Auxiliary {
  public id?: string;
  public churchId?: string;
  public name?: string;
  public description?: string;
  public importKey?: string;
  public removed?: boolean;
}
