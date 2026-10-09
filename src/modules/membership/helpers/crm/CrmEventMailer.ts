import { Repos } from "../../repositories/Repos.js";
import { RepoManager } from "../../../../shared/infrastructure/RepoManager.js";
import { Environment } from "../index.js";
import { CrmConfig } from "./CrmConfig.js";
import { eventUrl, KIND_LABEL, publicSiteUrl } from "./CrmEventService.js";
import { TransactionalEmailSender } from "../../../../shared/helpers/TransactionalEmailSender.js";
import { UnsubscribeTokenHelper } from "../../../../shared/helpers/UnsubscribeTokenHelper.js";

/**
 * Event email, tied to the CRM.
 *
 *   confirmation  sent the moment someone registers
 *   reminder      offsetMinutes before the start (e.g. -1440 = a day before, -300 = 5 hours before)
 *   followup      offsetMinutes after the end (or the start when no end is set)
 *   invite/update one-off, at sendAt, to an audience: the event's registrants, or CRM people
 *                 picked by filters (only people with contact consent "yes")
 *
 * Every email shows the event time in the reader's own time zone. A RailwayCron tick (every
 * minute) sends what is due; crmEventEmailSends makes each (email, recipient) exactly-once, and a
 * late registrant never gets reminders that fell due before they signed up. Invitations, updates
 * and follow-ups skip addresses on the church's unsubscribe list and carry a one-click unsubscribe
 * link; confirmations and reminders are part of the registration the person asked for.
 */

export interface Recipient { key: string; email: string; firstName: string; timezone: string | null; personId: string | null; registeredAt?: Date | null }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const DEFAULT_EMAILS = [
  {
    kind: "confirmation",
    offsetMinutes: null,
    enabled: true,
    subject: "You are registered: {{eventTitle}}",
    body: "Dear {{firstName}},\n\nThank you for registering for {{eventTitle}}. We are glad you are coming.\n\nWhen: {{eventTime}}\n{{joinLine}}\n\nYou can see the details and share the flyer with others here: {{eventUrl}}\n\nWe will send you a reminder before we begin.\n\nGod bless you,\nBible Teachers International"
  },
  {
    kind: "reminder",
    offsetMinutes: -1440,
    enabled: true,
    subject: "Tomorrow: {{eventTitle}}",
    body: "Dear {{firstName}},\n\nThis is a reminder that {{eventTitle}} begins in one day.\n\nWhen: {{eventTime}}\n{{joinLine}}\n\nDetails: {{eventUrl}}\n\nSee you there,\nBible Teachers International"
  },
  {
    kind: "reminder",
    offsetMinutes: -60,
    enabled: true,
    subject: "Starting in 1 hour: {{eventTitle}}",
    body: "Dear {{firstName}},\n\n{{eventTitle}} begins in one hour, at {{eventTime}}.\n{{joinLine}}\n\nGod bless you,\nBible Teachers International"
  },
  {
    kind: "followup",
    offsetMinutes: 1440,
    enabled: false,
    subject: "Thank you for joining {{eventTitle}}",
    body: "Dear {{firstName}},\n\nThank you for being with us for {{eventTitle}}. We pray the Word you received bears fruit in your life and ministry.\n\nIf you have a prayer request or a question, simply reply to this email.\n\nGod bless you,\nBible Teachers International"
  }
];

export class CrmEventMailer {
  static async createDefaults(repos: Repos, churchId: string, eventId: string) {
    for (const d of DEFAULT_EMAILS) await repos.crmEvent.saveEmail(churchId, { eventId, ...d });
  }

  /** "Saturday, November 14, 7:00 PM West Africa Time" in the reader's zone. */
  static timeIn(at: Date | null, tz: string): string {
    if (!at) return "to be announced";
    try {
      return new Date(at).toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "long" });
    } catch {
      return new Date(at).toUTCString();
    }
  }

  static merge(template: string, ev: any, r: Recipient, html: boolean): string {
    const tz = r.timezone || ev.timezone;
    const join = ev.joinUrl ? `How to join: ${ev.joinUrl}` : ev.location ? `Where: ${ev.location}` : "";
    const fields: Record<string, string> = {
      firstName: r.firstName || "friend",
      eventTitle: ev.title,
      eventKind: KIND_LABEL[ev.kind] || "event",
      eventTime: CrmEventMailer.timeIn(ev.startsAt, tz),
      hostTime: CrmEventMailer.timeIn(ev.startsAt, ev.timezone),
      joinUrl: ev.joinUrl || "",
      joinLine: join,
      location: ev.location || "",
      eventUrl: eventUrl(ev.slug),
      flyerUrl: ev.flyerUrl || ""
    };
    const out = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k in fields ? (html ? esc(fields[k]) : fields[k]) : ""));
    return out.replace(/\n{3,}/g, "\n\n");
  }

  /** Plain text with blank-line paragraphs -> simple HTML with links. */
  static toHtml(text: string): string {
    return text.trim().split(/\n{2,}/).map((p) =>
      "<p style=\"margin:0 0 14px;line-height:1.55\">" +
      p.split("\n").map((line) => line.replace(/(https?:\/\/[^\s<]+)/g, "<a href=\"$1\" style=\"color:#0B1D3A;font-weight:600\">$1</a>")).join("<br>") +
      "</p>").join("");
  }

  private static async sender(churchId: string): Promise<{ from: string; replyTo?: string; messaging: any }> {
    const messaging = await RepoManager.getRepos<any>("messaging");
    const settings = await messaging.churchEmailSettings.loadByChurch(churchId).catch(() => null);
    const clean = (s: string) => String(s || "").replace(/[\r\n]/g, " ").trim();
    const fromEmail = settings?.fromEmail || process.env.CRM_FROM_EMAIL || Environment.supportEmail || "noreply@huro.church";
    // The ministry's name, not the campaign sender's personal name (CRM_FROM_NAME overrides).
    const fromName = clean(process.env.CRM_FROM_NAME || "Bible Teachers International");
    return { from: `${fromName} <${fromEmail}>`, replyTo: settings?.replyTo ? clean(settings.replyTo) : undefined, messaging };
  }

  /** Send one email to one recipient (claims the slot first; returns false when already sent). */
  static async sendOne(repos: Repos, churchId: string, ev: any, email: any, r: Recipient, opts: { marketing: boolean; sender?: any; test?: boolean } = { marketing: false }): Promise<"sent" | "skipped" | "failed"> {
    const sender = opts.sender || (await CrmEventMailer.sender(churchId));
    if (opts.marketing && (await sender.messaging.emailSuppression.isSuppressed(churchId, r.email))) return "skipped";
    if (!opts.test && !(await repos.crmEvent.claimSend(churchId, email.id, r.key))) return "skipped";

    let listUnsubscribeUrl: string | undefined;
    let footer = "";
    if (opts.marketing) {
      const token = UnsubscribeTokenHelper.create(churchId, r.email, email.id);
      listUnsubscribeUrl = `${Environment.messagingApi}/unsubscribe/one-click?token=${token}`;
      footer = `<p style="margin:24px 0 0;font-size:12px;color:#6B7280">You are receiving this because you told us we may contact you about events and Bible studies. <a href="${Environment.messagingApi}/unsubscribe/?token=${token}" style="color:#6B7280">Unsubscribe</a></p>`;
    }
    const subject = CrmEventMailer.merge(email.subject, ev, r, false).replace(/[\r\n]+/g, " ").slice(0, 250);
    const text = CrmEventMailer.merge(email.body, ev, r, false);
    const image = ev.imageUrl ? `<p style="margin:0 0 18px"><img src="${esc(ev.imageUrl)}" alt="" style="max-width:100%;border-radius:8px"></p>` : "";
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1F2937;max-width:600px">${image}${CrmEventMailer.toHtml(CrmEventMailer.merge(email.body, ev, r, true))}${footer}</div>`;

    if (!Environment.isMailConfigured) {
      console.log(`[crm-events] (mail not configured) to ${r.email}: ${subject}`);
      if (!opts.test) await repos.crmEvent.finishSend(email.id, r.key, true);
      return "sent";
    }
    const res = await TransactionalEmailSender.sendListEmail({
      from: sender.from,
      replyTo: sender.replyTo,
      to: r.email,
      subject,
      contents: html,
      appName: "Bible Teachers International",
      appUrl: publicSiteUrl(),
      text: text + (opts.marketing ? "\n\nUnsubscribe: " + listUnsubscribeUrl?.replace("/one-click", "/") : ""),
      listUnsubscribeUrl
    });
    if (!opts.test) await repos.crmEvent.finishSend(email.id, r.key, res.success, res.error);
    return res.success ? "sent" : "failed";
  }

  static registrantToRecipient(reg: any): Recipient {
    return { key: "reg:" + reg.id, email: reg.email, firstName: reg.firstName || "", timezone: reg.timezone, personId: reg.personId, registeredAt: reg.createdAt ? new Date(reg.createdAt) : null };
  }

  static async sendConfirmation(repos: Repos, churchId: string, eventId: string, registrationId: string) {
    const ev = await repos.crmEvent.load(churchId, eventId);
    const reg = await repos.crmEvent.loadRegistration(churchId, registrationId);
    const email = (await repos.crmEvent.emails(churchId, eventId)).find((e: any) => e.kind === "confirmation" && e.enabled);
    if (!ev || !reg || !email) return;
    const out = await CrmEventMailer.sendOne(repos, churchId, ev, email, CrmEventMailer.registrantToRecipient(reg));
    if (out === "sent") await repos.crmEvent.markEmailSent(churchId, email.id, 1);
  }

  /** People an invite/update goes to. CRM audiences need contact consent "yes". */
  static async audience(repos: Repos, churchId: string, ev: any, aud: any): Promise<Recipient[]> {
    const type = aud?.type || "registrants";
    if (type === "registrants") {
      return (await repos.crmEvent.registrations(churchId, ev.id)).filter((r: any) => r.status !== "cancelled").map(CrmEventMailer.registrantToRecipient);
    }
    const rows = (await repos.crm.search(churchId, { countryCode: aud.countryCode || undefined, tagId: aud.tagId || undefined, status: aud.status || undefined, q: aud.q || undefined, consent: "yes", limit: 5000 })).rows;
    let picked = rows;
    if (Array.isArray(aud.personIds) && aud.personIds.length) {
      const set = new Set(aud.personIds);
      picked = (await repos.crm.search(churchId, { consent: "yes", limit: 5000 })).rows.filter((r: any) => set.has(r.id));
    }
    const seen = new Set<string>();
    return picked.filter((p: any) => p.email && !seen.has(p.email.toLowerCase()) && seen.add(p.email.toLowerCase()))
      .map((p: any) => ({ key: "p:" + p.id, email: p.email, firstName: p.firstName || "", timezone: p.timezone || null, personId: p.id }));
  }

  /** The minute tick: send every reminder / follow-up / one-off that is due. */
  static async tick(repos: Repos, now = new Date()): Promise<{ sent: number; failed: number }> {
    const churchId = await CrmConfig.churchId(repos);
    if (!churchId) return { sent: 0, failed: 0 };
    let sent = 0, failed = 0;
    const emails = (await repos.crmEvent.activeEmails()).filter((e: any) => e.churchId === churchId && e.kind !== "confirmation");
    const sender = emails.length ? await CrmEventMailer.sender(churchId) : null;
    for (const email of emails) {
      const start = email.eventStartsAt ? new Date(email.eventStartsAt) : null;
      const end = email.eventEndsAt ? new Date(email.eventEndsAt) : start;
      let due: Date | null = null;
      let until: Date | null = null;
      if (email.kind === "reminder" && start && email.offsetMinutes !== null) { due = new Date(start.getTime() + email.offsetMinutes * 60000); until = start; } else if (email.kind === "followup" && end && email.offsetMinutes !== null) { due = new Date(end.getTime() + email.offsetMinutes * 60000); until = new Date(due.getTime() + 7 * 86400000); } else if ((email.kind === "invite" || email.kind === "update") && email.sendAt) { due = new Date(email.sendAt); until = new Date(due.getTime() + 2 * 86400000); }
      if (!due || now < due || (until && now >= until)) continue;

      const ev = await repos.crmEvent.load(churchId, email.eventId);
      if (!ev) continue;
      const marketing = email.kind !== "reminder";
      let recipients = await CrmEventMailer.audience(repos, churchId, ev, email.kind === "invite" ? email.audience : { type: email.audience?.type || "registrants", ...(email.audience || {}) });
      // Reminders only go to people who were registered when they fell due.
      if (email.kind === "reminder") recipients = recipients.filter((r) => !r.registeredAt || r.registeredAt <= due!);
      let count = 0;
      for (const r of recipients.slice(0, 2000)) {
        const res = await CrmEventMailer.sendOne(repos, churchId, ev, email, r, { marketing, sender });
        if (res === "sent") { sent++; count++; } else if (res === "failed") failed++;
      }
      if (count) await repos.crmEvent.markEmailSent(churchId, email.id, count);
    }
    return { sent, failed };
  }
}
