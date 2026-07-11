import { type Kysely } from "kysely";

// Phase 13 (Tracking Ingestion) — a single-column NON-unique index on
// campaignRecipients(providerMessageId) for the ANONYMOUS webhook tenant lookup.
//
// The SNS/SES webhook has NO churchId — it derives the tenant FROM the recipient
// row by matching ev.mail.messageId → campaignRecipients.providerMessageId (see
// CampaignRecipientRepo.loadByProviderMessageIdAnyChurch). The existing
// idx_campaignRecipients_church_providerMsg leads with churchId, so it CANNOT
// optimize a churchId-less lookup (RESEARCH Pitfall 2). This adds the leading-
// column index the hot path needs.
//
// NOT UNIQUE: providerMessageId is nullable and is not guaranteed unique in the
// schema (a provider could, in theory, reuse an id across recipients; the send
// pipeline stamps the SES MessageId which is effectively unique but the schema
// does not enforce it — so a plain index, never a UNIQUE constraint).
//
// The date prefix sorts strictly after 2026-07-08_email_campaigns.ts — Kysely
// rejects out-of-order migrations (project memory / RESEARCH Pitfall 3). One
// up(), one down(). No table changes.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createIndex("idx_campaignRecipients_providerMsg")
    .on("campaignRecipients")
    .columns(["providerMessageId"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex("idx_campaignRecipients_providerMsg")
    .on("campaignRecipients")
    .execute();
}
