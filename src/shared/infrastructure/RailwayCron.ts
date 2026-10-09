import { RepoManager } from "./RepoManager.js";

const FIFTEEN_SECONDS_MS = 15 * 1000;
const THIRTY_SECONDS_MS = 30 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const msUntilNext5amUtc = (): number => {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
};

const safe = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    console.warn(`[cron] ${label} starting`);
    await fn();
    console.warn(`[cron] ${label} done`);
  } catch (error: unknown) {
    console.error(`[cron] ${label} failed:`, error);
  }
};

const runThirtyMinute = async (): Promise<void> => {
  const { NotificationHelper } = await import("../../modules/messaging/helpers/NotificationHelper.js");
  const repos = await RepoManager.getRepos<any>("messaging");
  NotificationHelper.init(repos);
  await NotificationHelper.escalateDelivery();
  await NotificationHelper.sendEmailNotifications("individual");
};

const runMidnight = async (): Promise<void> => {
  const { NotificationHelper } = await import("../../modules/messaging/helpers/NotificationHelper.js");
  const { AutomationHelper } = await import("../../modules/bridge/helpers/AutomationHelper.js");
  const messagingRepos = await RepoManager.getRepos<any>("messaging");
  NotificationHelper.init(messagingRepos);
  await AutomationHelper.remindServiceRequests();
  const contentRepos = await RepoManager.getRepos<any>("content");
  await contentRepos.streamingService.advanceRecurringServices();
  await NotificationHelper.sendEmailNotifications("daily");
};

const runWebhookDeliveries = async (): Promise<void> => {
  const { WebhookDeliveryWorker } = await import("../webhooks/index.js");
  const repos = await RepoManager.getRepos<any>("membership");
  await WebhookDeliveryWorker.process(repos);
};

// Email campaign send drain (Phase 11, Plan 02) — off-thread from the /send
// request. ~15s cadence (faster than webhooks) so a large blast progresses
// promptly. The worker itself is exactly-once (per-recipient DB claim), so
// overlapping timers are safe.
const runCampaignSends = async (): Promise<void> => {
  const { CampaignSendWorker } = await import("../../modules/messaging/helpers/CampaignSendWorker.js");
  const repos = await RepoManager.getRepos<any>("messaging");
  await CampaignSendWorker.process(repos);
};

// Scheduled-send poller (Phase 15, SND-04) — claims due scheduled campaigns
// scheduled→sending; the 15s runCampaignSends drain then sends them off-thread.
// 30s cadence comfortably satisfies the 5-minute lead-time contract; the claim is
// a cheap single indexed read + version-guarded UPDATE. Its OWN safe()-wrapped
// interval (isolated from the send drain — a scheduled-claim failure must never
// abort a send in flight).
const runScheduledSends = async (): Promise<void> => {
  const { ScheduledSendWorker } = await import("../../modules/messaging/helpers/ScheduledSendWorker.js");
  const repos = await RepoManager.getRepos<any>("messaging");
  await ScheduledSendWorker.process(repos);
};

// Ministry-wide CRM (2026-10): every Mary Banks ID gets a church person (every 5 min), and what
// people do on the other sites is pulled into their timeline (every 30 min). A run still going
// when the next tick fires is skipped, never doubled. CRM_SYNC=off stops both.
const crmBusy: Record<string, boolean> = {};
const runCrm = async (job: "keycloak" | "activity"): Promise<void> => {
  if (crmBusy[job]) return;
  crmBusy[job] = true;
  try {
    const repos = await RepoManager.getRepos<any>("membership");
    if (job === "keycloak") {
      const { CrmSyncService } = await import("../../modules/membership/helpers/crm/CrmSyncService.js");
      const r = await new CrmSyncService(repos).run();
      if (r.created || r.linked || r.removed) console.warn("[crm] keycloak sync", JSON.stringify(r));
    } else {
      const { CrmActivitySync } = await import("../../modules/membership/helpers/crm/CrmActivitySync.js");
      console.warn("[crm] activity sync", JSON.stringify(await new CrmActivitySync(repos).run()));
    }
  } finally {
    crmBusy[job] = false;
  }
};

let crmEmailBusy = false;
const runCrmEmails = async (): Promise<void> => {
  if (crmEmailBusy) return;
  crmEmailBusy = true;
  try {
    const repos = await RepoManager.getRepos<any>("membership");
    const { CrmEventMailer } = await import("../../modules/membership/helpers/crm/CrmEventMailer.js");
    const r = await CrmEventMailer.tick(repos);
    if (r.sent || r.failed) console.warn("[crm] event emails", JSON.stringify(r));
  } catch (e) {
    console.error("[crm] event emails failed:", e);
  } finally {
    crmEmailBusy = false;
  }
};

export const startRailwayCron = (): void => {
  if (!process.env.RAILWAY_ENVIRONMENT) return;

  console.warn("[cron] Railway in-process scheduler starting");

  setInterval(() => void safe("30-min timer", runThirtyMinute), THIRTY_MINUTES_MS);
  setInterval(() => void safe("webhook deliveries", runWebhookDeliveries), ONE_MINUTE_MS);
  setInterval(() => void safe("campaign sends", runCampaignSends), FIFTEEN_SECONDS_MS);
  setInterval(() => void safe("scheduled sends", runScheduledSends), THIRTY_SECONDS_MS);

  const scheduleDaily = (label: string, fn: () => Promise<void>): void => {
    setTimeout(() => {
      void safe(label, fn);
      setInterval(() => void safe(label, fn), ONE_DAY_MS);
    }, msUntilNext5amUtc());
  };

  scheduleDaily("midnight timer", runMidnight);

  if ((process.env.CRM_SYNC || "on").toLowerCase() !== "off") {
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    setTimeout(() => void safe("crm keycloak sync", () => runCrm("keycloak")), 60 * 1000);
    setInterval(() => void safe("crm keycloak sync", () => runCrm("keycloak")), FIVE_MINUTES_MS);
    setTimeout(() => void safe("crm activity sync", () => runCrm("activity")), 3 * 60 * 1000);
    setInterval(() => void safe("crm activity sync", () => runCrm("activity")), THIRTY_MINUTES_MS);
    // Event reminders / follow-ups / scheduled invitations: due ones go out within a minute.
    setInterval(() => void runCrmEmails(), ONE_MINUTE_MS);
  }
};
