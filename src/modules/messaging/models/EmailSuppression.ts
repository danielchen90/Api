// Church-wide suppression list. UNIQUE (churchId, email). `reason` +
// `sourceCampaignId` + `createdAt` carry provenance. Mirrors the
// 2026-07-08_email_campaigns.ts columns.
export class EmailSuppression {
  public id?: string;
  public churchId?: string;
  public email?: string;
  public reason?: string;
  public sourceCampaignId?: string;
  public createdAt?: Date;
}
