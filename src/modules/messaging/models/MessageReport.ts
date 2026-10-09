export class MessageReport {
  public id?: string;
  public churchId?: string;
  public messageId?: string;
  public conversationId?: string;
  public reporterPersonId?: string | null;
  public reporterIp?: string | null;
  public reason?: string;
  public note?: string | null;
  public messageSnapshot?: string | null;
  public senderPersonId?: string | null;
  public senderDisplayName?: string | null;
  public createdAt?: Date;
  public resolvedAt?: Date | null;
  public resolvedBy?: string | null;
  public action?: string | null;
}
