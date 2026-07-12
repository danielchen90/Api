// DLV-01 — the provider SEAM (Phase 11, Plan 01). This interface is the ONLY
// coupling point between the send pipeline and a concrete email transport. It is
// deliberately MINIMAL so that a later provider swap (e.g. Resend) touches ONE
// file — the implementation — and never the worker. Keep this file free of any
// SES/AWS import: it is a pure contract.

// One outbound email. `html` + `text` are BOTH required (DLV-05): the transport
// assembles a multipart/alternative message so every recipient gets an
// email-safe HTML part AND a plain-text alternative from a single send() call.
// `campaignId`/`recipientId` are carried for FUTURE SNS event correlation
// (Phase 13) only — they are NOT idempotency tokens (see SesEmailDeliveryProvider,
// Pitfall 5).
export interface EmailSendRequest {
  from: string;
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  campaignId: string;
  recipientId: string;
  // CMP-01 — when present, the transport sets RFC 8058 List-Unsubscribe +
  // List-Unsubscribe-Post:One-Click headers. Absent → a plain send
  // (transactional callers / test-sends never set it).
  listUnsubscribeUrl?: string;
}

// The transport's verdict for ONE send. `retryable` lets the Plan 02 worker
// distinguish a transient failure (throttle / 5xx — safe to retry) from a
// permanent one (bad address / 4xx — do NOT retry). A provider message id, when
// present, is stored for later SNS event correlation (Phase 13).
export interface EmailSendResult {
  providerMessageId?: string;
  success: boolean;
  error?: string;
  retryable?: boolean;
}

// The seam. A concrete provider implements exactly this. `send()` must NEVER
// throw — every failure is reported through EmailSendResult so the worker can
// decide retry vs. permanent-fail per recipient without a try/catch of its own.
export interface IEmailDeliveryProvider {
  send(req: EmailSendRequest): Promise<EmailSendResult>;
}
