// Append-only provider webhook event. `providerEventId` is UNIQUE (idempotent
// webhook). `payloadJson` stays a RAW STRING; `createdAt` is a Date. Mirrors the
// 2026-07-08_email_campaigns.ts columns.
export class CampaignEvent {
  public id?: string;
  public churchId?: string;
  public campaignId?: string;
  public recipientId?: string;
  public eventType?: string;
  public payloadJson?: string;
  public providerEventId?: string;
  public createdAt?: Date;
}
