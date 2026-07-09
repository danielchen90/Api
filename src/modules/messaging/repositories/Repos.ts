import { BlockedIpRepo, ConnectionRepo, ConversationRepo, DeliveryLogRepo, DeviceRepo, DeviceContentRepo, EmailTemplateRepo, MessageRepo, NotificationRepo, NotificationPreferenceRepo, PrivateMessageRepo, TextingProviderRepo, SentTextRepo, EmailCampaignRepo, CampaignRecipientRepo, CampaignEventRepo, EmailSuppressionRepo, SavedAudienceRepo, ChurchEmailSettingsRepo } from "./index.js";

export class Repos {
  public blockedIp: BlockedIpRepo;
  public connection: ConnectionRepo;
  public conversation: ConversationRepo;
  public deliveryLog: DeliveryLogRepo;
  public device: DeviceRepo;
  public deviceContent: DeviceContentRepo;
  public emailTemplate: EmailTemplateRepo;
  public message: MessageRepo;
  public notification: NotificationRepo;
  public notificationPreference: NotificationPreferenceRepo;
  public privateMessage: PrivateMessageRepo;
  public textingProvider: TextingProviderRepo;
  public sentText: SentTextRepo;
  public emailCampaign: EmailCampaignRepo;
  public campaignRecipient: CampaignRecipientRepo;
  public campaignEvent: CampaignEventRepo;
  public emailSuppression: EmailSuppressionRepo;
  public savedAudience: SavedAudienceRepo;
  public churchEmailSettings: ChurchEmailSettingsRepo;

  public static getCurrent = () => new Repos();

  constructor() {
    this.blockedIp = new BlockedIpRepo();
    this.connection = new ConnectionRepo();
    this.conversation = new ConversationRepo();
    this.deliveryLog = new DeliveryLogRepo();
    this.device = new DeviceRepo();
    this.deviceContent = new DeviceContentRepo();
    this.emailTemplate = new EmailTemplateRepo();
    this.message = new MessageRepo();
    this.notification = new NotificationRepo();
    this.notificationPreference = new NotificationPreferenceRepo();
    this.privateMessage = new PrivateMessageRepo();
    this.textingProvider = new TextingProviderRepo();
    this.sentText = new SentTextRepo();
    this.emailCampaign = new EmailCampaignRepo();
    this.campaignRecipient = new CampaignRecipientRepo();
    this.campaignEvent = new CampaignEventRepo();
    this.emailSuppression = new EmailSuppressionRepo();
    this.savedAudience = new SavedAudienceRepo();
    this.churchEmailSettings = new ChurchEmailSettingsRepo();
  }
}
