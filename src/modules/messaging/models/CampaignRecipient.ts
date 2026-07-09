// One frozen row per resolved recipient. `email`/`campusId` are FROZEN at resolve
// time (audience snapshot — never re-scoped here). `mergeSnapshot` stays a RAW
// STRING; datetimes are Date. Mirrors the 2026-07-08_email_campaigns.ts columns.
export class CampaignRecipient {
  public id?: string;
  public churchId?: string;
  public campaignId?: string;
  public personId?: string;
  public email?: string;
  public campusId?: string;
  public mergeSnapshot?: string;
  public status?: string;
  public openedAt?: Date;
  public clickedAt?: Date;
  public bouncedAt?: Date;
  public unsubscribedAt?: Date;
  public providerMessageId?: string;
  public errorMessage?: string;
  public createdAt?: Date;
}
