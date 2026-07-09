// The email-campaign entity (v2.0 Communications). One field per column of the
// 2026-07-08_email_campaigns.ts migration. JSON columns stay RAW STRINGS on the
// model (no typed parse — RESEARCH Open Question 1); `removed` is a boolean
// (bit(1)); `version`/rollup counters are numbers (int); datetimes are Date.
export class EmailCampaign {
  public id?: string;
  public churchId?: string;
  public status?: string;
  public version?: number;
  public name?: string;
  public scheduledAt?: Date;
  public audienceFilterJson?: string;
  public templateId?: string;
  public blockJson?: string;
  public subject?: string;
  public renderedHtml?: string;
  public renderedText?: string;
  public recipientCount?: number;
  public sentCount?: number;
  public failedCount?: number;
  public createdAt?: Date;
  public createdBy?: string;
  public updatedAt?: Date;
  public removed?: boolean;
}
