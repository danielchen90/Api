import type { BlockedIp, Connection, Conversation, DeliveryLog, Device, DeviceContent, EmailTemplate, Message, Notification, NotificationPreference, PrivateMessage, SentText, TextingProvider, EmailCampaign, CampaignRecipient, CampaignEvent, EmailSuppression, SavedAudience, ChurchEmailSettings } from "../models/index.js";

export interface MessagingDatabase {
  blockedIps: BlockedIp;
  connections: Connection;
  conversations: Omit<Conversation, "messages">;
  deliveryLogs: DeliveryLog;
  devices: Device;
  deviceContent: DeviceContent;
  emailTemplates: EmailTemplate;
  messages: Message;
  notifications: Notification;
  notificationPreferences: NotificationPreference;
  privateMessages: Omit<PrivateMessage, "conversation">;
  sentTexts: SentText;
  textingProviders: TextingProvider;
  emailCampaigns: EmailCampaign;
  campaignRecipients: CampaignRecipient;
  campaignEvents: CampaignEvent;
  emailSuppression: EmailSuppression;
  savedAudiences: SavedAudience;
  churchEmailSettings: ChurchEmailSettings;
}
