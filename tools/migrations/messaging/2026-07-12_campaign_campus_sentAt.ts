import { type Kysely, sql } from "kysely";

// Phase 16 (Campaign History & Record) — the two REAL data-model gaps that block
// the Campus column, Campus/Sender facets, and inline engagement on the campaign
// LIST page. Additive ONLY (two nullable columns on emailCampaigns), so it lands
// under the running send pipeline without touching any existing column or the
// LOCKED status set.
//
//   campusId  char(11)  — the campaign's OWNING campus. The controller already
//                         WRITES model.campusId but EmailCampaignRepo silently
//                         DROPPED it (no insert/update/read + no column), so every
//                         campaign's campusId was effectively NULL and the list's
//                         Campus column showed "—" for all rows / the Campus facet
//                         matched nothing (RESEARCH Gap 1). Nullable — pre-Phase-16
//                         rows keep NULL (a campaign with no explicit campus is
//                         legitimately church-wide).
//
//   sentAt    datetime  — the explicit instant the campaign flipped to `sent`
//                         (stamped by CampaignSendWorker at the sent flip). createdAt
//                         is when the draft was made, not when it went out; the
//                         history record needs the SEND time (RESEARCH Gap 3).
//                         Nullable — draft/scheduled/failed/canceled rows have none.
//
// The date prefix sorts strictly AFTER the last-applied messaging migration
// 2026-07-11_tracking_providerMsg_index.ts — Kysely rejects out-of-order
// migrations (project memory / RESEARCH Pitfall 3). Two separate addColumn().execute()
// calls (MySQL ALTER TABLE via Kysely applies one column change per statement here).
// NO physical-immutability constraint on the row — the send pipeline still updates
// status + rollup counters after sentAt is stamped (RESEARCH Immutability §).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("emailCampaigns")
    .addColumn("campusId", sql`char(11)`)
    .execute();

  await db.schema
    .alterTable("emailCampaigns")
    .addColumn("sentAt", sql`datetime`)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("emailCampaigns").dropColumn("sentAt").execute();
  await db.schema.alterTable("emailCampaigns").dropColumn("campusId").execute();
}
