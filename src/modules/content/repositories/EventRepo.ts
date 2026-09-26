import { DateHelper, UniqueIdHelper } from "@churchapps/apihelper";
import { sql } from "kysely";
import { getDb } from "../db/index.js";
import { Event } from "../models/index.js";
import { injectable } from "inversify";

@injectable()
export class EventRepo {
  public async save(model: Event) {
    return model.id ? this.update(model) : this.create(model);
  }

  private async create(model: Event): Promise<Event> {
    model.id = UniqueIdHelper.shortId();
    const m: any = { ...model };
    if (m.start) m.start = DateHelper.toMysqlDate(m.start);
    if (m.end) m.end = DateHelper.toMysqlDate(m.end);
    if (m.registrationOpenDate) m.registrationOpenDate = DateHelper.toMysqlDate(m.registrationOpenDate);
    if (m.registrationCloseDate) m.registrationCloseDate = DateHelper.toMysqlDate(m.registrationCloseDate);
    await getDb().insertInto("events").values({
      id: model.id,
      churchId: model.churchId,
      groupId: m.groupId,
      allDay: m.allDay,
      start: m.start,
      end: m.end,
      title: m.title,
      description: m.description,
      visibility: m.visibility,
      recurrenceRule: m.recurrenceRule,
      registrationEnabled: m.registrationEnabled,
      capacity: m.capacity,
      registrationOpenDate: m.registrationOpenDate,
      registrationCloseDate: m.registrationCloseDate,
      tags: m.tags,
      formId: m.formId,
      approvalStatus: m.approvalStatus,
      requestedBy: m.requestedBy,
      campusId: m.campusId,
      publicListing: m.publicListing === undefined ? undefined : (m.publicListing ? 1 : 0),
      location: m.location,
      registrationUrl: m.registrationUrl,
      image: m.image
    } as any).execute();
    return model;
  }

  private async update(model: Event): Promise<Event> {
    const m: any = { ...model };
    if (m.start) m.start = DateHelper.toMysqlDate(m.start);
    if (m.end) m.end = DateHelper.toMysqlDate(m.end);
    if (m.registrationOpenDate) m.registrationOpenDate = DateHelper.toMysqlDate(m.registrationOpenDate);
    if (m.registrationCloseDate) m.registrationCloseDate = DateHelper.toMysqlDate(m.registrationCloseDate);
    await getDb().updateTable("events").set({
      groupId: m.groupId,
      allDay: m.allDay,
      start: m.start,
      end: m.end,
      title: m.title,
      description: m.description,
      visibility: m.visibility,
      recurrenceRule: m.recurrenceRule,
      registrationEnabled: m.registrationEnabled,
      capacity: m.capacity,
      registrationOpenDate: m.registrationOpenDate,
      registrationCloseDate: m.registrationCloseDate,
      tags: m.tags,
      formId: m.formId,
      approvalStatus: m.approvalStatus,
      requestedBy: m.requestedBy,
      campusId: m.campusId,
      publicListing: m.publicListing === undefined ? undefined : (m.publicListing ? 1 : 0),
      location: m.location,
      registrationUrl: m.registrationUrl,
      image: m.image
    } as any).where("id", "=", model.id).where("churchId", "=", model.churchId).execute();
    return model;
  }

  public async delete(churchId: string, id: string) {
    await getDb().deleteFrom("events").where("id", "=", id).where("churchId", "=", churchId).execute();
  }

  public async load(churchId: string, id: string): Promise<Event | undefined> {
    return (await getDb().selectFrom("events").selectAll().where("id", "=", id).where("churchId", "=", churchId).executeTakeFirst()) ?? null;
  }

  public async loadAll(churchId: string): Promise<Event[]> {
    return getDb().selectFrom("events").selectAll().where("churchId", "=", churchId).orderBy("start").execute() as any;
  }

  public async loadForGroup(churchId: string, groupId: string) {
    return getDb().selectFrom("events").selectAll()
      .where("groupId", "=", groupId)
      .where("churchId", "=", churchId)
      .orderBy("start").execute() as any;
  }

  public async loadPublicForGroup(churchId: string, groupId: string) {
    return getDb().selectFrom("events").selectAll()
      .where("groupId", "=", groupId)
      .where("churchId", "=", churchId)
      .where("visibility", "=", "public")
      .orderBy("start").execute() as any;
  }

  public async loadByTag(churchId: string, tag: string): Promise<Event[]> {
    return getDb().selectFrom("events").selectAll()
      .where("churchId", "=", churchId)
      .where("tags", "like", "%" + tag + "%")
      .orderBy("start").execute() as any;
  }

  public async loadPendingApproval(churchId: string): Promise<Event[]> {
    return getDb().selectFrom("events").selectAll()
      .where("churchId", "=", churchId)
      .where("approvalStatus", "=", "pending")
      .orderBy("start").execute() as any;
  }

  // Events with an approved booking for the room, for per-room iCal feeds.
  public async loadForRoom(churchId: string, roomId: string): Promise<Event[]> {
    return getDb().selectFrom("events")
      .innerJoin("eventBookings", "eventBookings.eventId", "events.id")
      .selectAll("events")
      .where("events.churchId", "=", churchId)
      .where("eventBookings.roomId", "=", roomId)
      .where("eventBookings.status", "=", "approved")
      .orderBy("events.start").execute() as any;
  }

  public async loadRegistrationEnabled(churchId: string): Promise<Event[]> {
    return getDb().selectFrom("events").selectAll()
      .where("churchId", "=", churchId)
      .where("registrationEnabled", "=", 1 as any)
      .orderBy("start").execute() as any;
  }

  public async loadTimelineGroup(churchId: string, groupId: string, eventIds: string[]) {
    let query = sql`select *, 'event' as postType, id as postId from events
      where churchId=${churchId} AND ((
        groupId = ${groupId}
        and (end>curdate() or recurrenceRule IS NOT NULL)
      )`;
    if (eventIds.length > 0) {
      query = sql`${query} OR id IN (${sql.join(eventIds.map(id => sql`${id}`), sql`,`)})`;
    }
    query = sql`${query})`;
    const result = await query.execute(getDb());
    return result.rows;
  }

  public async loadTimeline(churchId: string, groupIds: string[], eventIds: string[]) {
    let query = sql`select *, 'event' as postType, id as postId from events
      where churchId=${churchId} AND ((
        (
          groupId IN (${sql.join(groupIds.map(id => sql`${id}`), sql`,`)})
          OR groupId IN (SELECT groupId FROM curatedEvents WHERE churchId=${churchId} AND eventId IS NULL)
          OR id IN (SELECT eventId from curatedEvents WHERE churchId=${churchId})
        )
        and (end>curdate() or recurrenceRule IS NOT NULL)
      )`;
    if (eventIds.length > 0) {
      query = sql`${query} OR id IN (${sql.join(eventIds.map(id => sql`${id}`), sql`,`)})`;
    }
    query = sql`${query})`;
    const result = await query.execute(getDb());
    return result.rows;
  }

  // Public website feed: publicListing events that can have an occurrence in [windowStart, windowEnd].
  // Recurring rows are returned whenever their series starts before the window end (the caller
  // expands them); one-off rows must overlap the window. Private / pending / rejected rows are
  // excluded here AND again by PublicEventFeed (defense in depth).
  public async loadPublicListed(churchId: string, windowStart: Date, windowEnd: Date, campusId?: string | null): Promise<Event[]> {
    let q = getDb().selectFrom("events").selectAll()
      .where("churchId", "=", churchId)
      .where("publicListing", "=", 1 as any)
      .where((eb) => eb.or([eb("visibility", "is", null), eb("visibility", "!=", "private")]))
      .where((eb) => eb.or([eb("approvalStatus", "is", null), eb("approvalStatus", "not in", ["pending", "rejected"])]))
      .where("start", "<=", DateHelper.toMysqlDate(windowEnd) as any)
      .where((eb) => eb.or([eb("end", ">=", DateHelper.toMysqlDate(windowStart) as any), eb("recurrenceRule", "is not", null)]));
    if (campusId) q = q.where((eb) => eb.or([eb("campusId", "=", campusId), eb("campusId", "is", null)]));
    return (await q.orderBy("start").limit(1000).execute()) as any;
  }

  public convertToModel(_churchId: string, data: any) { return data as Event; }
  public convertAllToModel(_churchId: string, data: any[]) { return (data || []) as Event[]; }

  protected rowToModel(row: any): Event {
    return {
      id: row.id,
      churchId: row.churchId,
      groupId: row.groupId,
      allDay: row.allDay,
      start: row.start,
      end: row.end,
      title: row.title,
      description: row.description,
      visibility: row.visibility,
      recurrenceRule: row.recurrenceRule,
      registrationEnabled: row.registrationEnabled,
      capacity: row.capacity,
      registrationOpenDate: row.registrationOpenDate,
      registrationCloseDate: row.registrationCloseDate,
      tags: row.tags,
      formId: row.formId,
      approvalStatus: row.approvalStatus,
      requestedBy: row.requestedBy,
      campusId: row.campusId ?? null,
      publicListing: !!row.publicListing,
      location: row.location ?? null,
      registrationUrl: row.registrationUrl ?? null,
      image: row.image ?? null
    };
  }
}
