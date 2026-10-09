export class Message {
  public id?: string;
  public churchId?: string;
  public conversationId?: string;
  public personId?: string;
  public displayName?: string;
  public timeSent?: Date;
  public timeUpdated?: Date;
  public messageType?: string;
  public content?: string;
  // HMAC of the sender's IP (chat safety: staff "Block from this stream"); never the raw IP.
  public ipHash?: string | null;
  // Same value as ipHash, as sent to clients (anonymous livestream block on this device).
  public senderKey?: string;
}
