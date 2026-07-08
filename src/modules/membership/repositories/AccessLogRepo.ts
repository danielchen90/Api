import { injectable } from "inversify";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { UniqueIdHelper } from "@churchapps/apihelper";
import { AccessLog } from "../models/index.js";

@injectable()
export class AccessLogRepo {
  public async save(model: AccessLog) {
    return model.id ? this.update(model) : this.create(model);
  }

  public async create(log: AccessLog): Promise<AccessLog> {
    log.id = UniqueIdHelper.shortId();
    await getDb().insertInto("accessLogs").values({
      id: log.id,
      churchId: log.churchId,
      userId: log.userId,
      appName: log.appName,
      loginTime: sql`NOW()` as any
    }).execute();
    return log;
  }

  private async update(log: AccessLog): Promise<AccessLog> {
    await getDb().updateTable("accessLogs").set({
      userId: log.userId,
      appName: log.appName
    }).where("id", "=", log.id).where("churchId", "=", log.churchId).execute();
    return log;
  }

  public async delete(churchId: string, id: string) {
    await getDb().deleteFrom("accessLogs").where("id", "=", id).where("churchId", "=", churchId).execute();
  }

  public async load(churchId: string, id: string) {
    return (await getDb().selectFrom("accessLogs").selectAll().where("id", "=", id).where("churchId", "=", churchId).executeTakeFirst()) ?? null;
  }

  public async loadAll(churchId: string) {
    return getDb().selectFrom("accessLogs").selectAll().where("churchId", "=", churchId).execute();
  }

  // READ side of the going-forward login capture (the write already fires in
  // UserChurchController.update via create() above — do NOT add a second write).
  // Most-recent logins for the church, newest first.
  public async loadRecent(churchId: string, limit = 25) {
    return getDb().selectFrom("accessLogs").selectAll()
      .where("churchId", "=", churchId)
      .orderBy("loginTime", "desc")
      .limit(limit)
      .execute();
  }

  // Weekly login counts, bucketed by ISO week of loginTime. Reuses the EXACT
  // STR_TO_DATE(concat(year, week, 'Sunday')) week-bucketing used by
  // AttendanceRepo.loadTrend so this series aligns week-for-week with the
  // attendance chart. Returns [{ week: Date, count: number }] ascending, limited
  // to the last `weeks` weeks.
  public async loadWeeklyCounts(churchId: string, weeks = 13) {
    const rows = await sql<any>`SELECT STR_TO_DATE(concat(year(a.loginTime), ' ', week(a.loginTime, 0), ' Sunday'), '%X %V %W') AS week, count(distinct(a.id)) as count FROM accessLogs a WHERE a.churchId=${churchId} AND a.loginTime >= DATE_SUB(CURDATE(), INTERVAL ${weeks} WEEK) GROUP BY year(a.loginTime), week(a.loginTime, 0), STR_TO_DATE(concat(year(a.loginTime), ' ', week(a.loginTime, 0), ' Sunday'), '%X %V %W') ORDER BY year(a.loginTime), week(a.loginTime, 0)`.execute(getDb());
    return rows.rows;
  }

  public convertToModel(_churchId: string, data: any) { return data; }
  public convertAllToModel(_churchId: string, data: any[]) { return data || []; }
}
