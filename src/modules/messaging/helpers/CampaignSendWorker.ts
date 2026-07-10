import { VerifiedDomainGate } from "./VerifiedDomainGate.js";
import { SesEmailDeliveryProvider } from "./SesEmailDeliveryProvider.js";
import { CampaignRenderHelper, CampaignRenderContext } from "./CampaignRenderHelper.js";
import { EmailCampaign, CampaignRecipient } from "../models/index.js";

// The DB-as-queue send drain (Phase 11, Plan 02). A near-copy of
// WebhookDeliveryWorker.process(repos): claim → render → send → mark → count,
// invoked on a short-interval timer by RailwayCron + the Lambda timer handler.
// This is the ONLY place SES sends happen — NEVER inside an HTTP request
// (SND-01 / DLV-03). The /send endpoint only OCC-claims the campaign and returns
// 202; the actual emails go out here, off the request thread.
//
// EXACTLY-ONCE (DLV-04): each recipient row is claimed pending→sending with a
// matched-rows-guarded UPDATE (CampaignRecipientRepo.claimForSending). Only the
// worker that WON the row (numUpdatedRows===1n) ever emails it. The DB row-claim
// IS the guard — SES v1 carries NO client idempotency token (Pitfall 5), so we do
// NOT invent one.
//
// NEVER-RESEND STUCK ROWS (Pitfall 4): a `sending` row is left uncertain — it may
// already be delivered (crash between SES-accept and mark-sent). We NEVER reset a
// `sending` row back to `pending`, and a campaign with a nonzero stuck-`sending`
// remainder does NOT flip to `sent` — it stays `sending` so the remainder is
// visible as "uncertain" rather than silently re-sent.
//
// RETRY POLICY: a failed send stays `failed` this phase (no requeue) — a richer
// retryable-requeue policy is deferred. Partial failure is expressed by
// failedCount, NEVER a `partially_sent` status (the status set is LOCKED to
// draft/scheduled/sending/sent/failed/canceled).
export class CampaignSendWorker {
  // Batch size cap (DLV-03) — never load/process more than this many rows per pass.
  private static readonly BATCH_SIZE = 100;

  public static async process(repos: any): Promise<{ attempted: number; succeeded: number; failed: number }> {
    // 1. Find every in-flight campaign across all churches (cross-tenant drain).
    const campaigns: EmailCampaign[] = await repos.emailCampaign.loadAllByStatus("sending");
    if (!campaigns || campaigns.length === 0) return { attempted: 0, succeeded: 0, failed: 0 };

    // 2. Discover the SES send rate ONCE per run and derive a min inter-send delay
    //    (simple sleep-paced token bucket; DLV-03 — never faster than MaxSendRate).
    const { maxSendRate } = await VerifiedDomainGate.quota();
    const minInterSendMs = maxSendRate > 0 ? Math.ceil(1000 / maxSendRate) : 0;

    // 3. One provider instance for the whole run.
    const provider = new SesEmailDeliveryProvider();

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;

    for (const campaign of campaigns) {
      // Compose the from-identity from this church's email settings. Sanitize
      // fromName — strip CR/LF to defeat header injection (Pitfall 6).
      const settings = await repos.churchEmailSettings.loadByChurch(campaign.churchId);
      if (!settings || !settings.fromEmail) continue; // no identity → cannot send this campaign yet
      const fromName = CampaignSendWorker.sanitizeHeader(settings.fromName);
      const from = fromName ? `${fromName} <${settings.fromEmail}>` : settings.fromEmail;
      const replyTo = settings.replyTo ? CampaignSendWorker.sanitizeHeader(settings.replyTo) : undefined;

      // Load the next batch of unsent rows (≤ BATCH_SIZE; DLV-03).
      const batch: CampaignRecipient[] = await repos.campaignRecipient.loadPendingBatch(
        campaign.churchId,
        campaign.id,
        CampaignSendWorker.BATCH_SIZE
      );

      let batchSent = 0;
      let batchFailed = 0;

      for (const recipient of batch) {
        // Claim the row pending→sending. If we did not win it, another drain took
        // it — skip (DLV-04, exactly-once).
        const won = await repos.campaignRecipient.claimForSending(campaign.churchId, recipient.id);
        if (!won) continue;

        attempted++;

        // Render per-recipient at send time through the ONE shared renderer
        // (CampaignRenderHelper) so the real send emits byte-identical merged HTML
        // — same strip + merge + footer + text-part — as preview and test-send.
        // The frozen mergeSnapshot is the merge data (person basics now; church /
        // campus / ordination keys once plan 12-02 enriches the freeze). Footer
        // context is derived from that SAME frozen snapshot (below), so the send
        // worker needs no membership-repo/HTTP lookup it cannot cheaply do here.
        const mergeData = CampaignSendWorker.mergeData(recipient);
        const context = CampaignSendWorker.renderContext(mergeData);
        const result = await CampaignRenderHelper.render(campaign, mergeData, context);

        const sent = await provider.send({
          from,
          replyTo,
          to: recipient.email,
          subject: result.subject,
          html: result.html,
          text: result.text,
          campaignId: campaign.id,
          recipientId: recipient.id
        });

        if (sent.success) {
          await repos.campaignRecipient.updateStatus(campaign.churchId, recipient.id, {
            status: "sent",
            providerMessageId: sent.providerMessageId
          });
          batchSent++;
          succeeded++;
        } else {
          // Failed stays `failed` — NEVER reset to pending (retryable requeue is
          // deferred). Record the error for the operator.
          await repos.campaignRecipient.updateStatus(campaign.churchId, recipient.id, {
            status: "failed",
            errorMessage: sent.error
          });
          batchFailed++;
          failed++;
        }

        // Pace to MaxSendRate (DLV-03).
        if (minInterSendMs > 0) await CampaignSendWorker.sleep(minInterSendMs);
      }

      // Bump the campaign rollup counters to ABSOLUTE current values (monotonic,
      // authoritative — a re-run never double-counts). updateCounters is NOT
      // version-guarded, so it never 409s.
      const counts = await repos.campaignRecipient.countByStatus(campaign.churchId, campaign.id);
      await repos.emailCampaign.updateCounters(campaign.churchId, campaign.id, {
        sentCount: counts.sent,
        failedCount: counts.failed
      });

      // Completion: flip to `sent` ONLY when nothing is pending AND nothing is
      // stuck `sending`. A nonzero stuck-`sending` remainder (a prior crash) keeps
      // the campaign `sending` so the uncertain rows stay visible — never resent,
      // never silently marked complete (Pitfall 4). Partial failure is carried by
      // failedCount, not a separate status.
      if (counts.pending === 0 && counts.sending === 0) {
        const bumped = await repos.emailCampaign.updateWithVersion(
          { ...campaign, status: "sent" },
          campaign.version
        );
        // A concurrent claimer (another drain / a scheduler) may have bumped the
        // version — that's fine; the next pass re-evaluates. Ignore 0n here.
        void bumped;
      }

      // Suppress unused-var lint on the per-batch tallies (kept for readability /
      // future logging).
      void batchSent;
      void batchFailed;
    }

    return { attempted, succeeded, failed };
  }

  // Strip CR/LF from a header-bound value (fromName / replyTo) — header injection
  // defense (Pitfall 6).
  private static sanitizeHeader(value?: string): string {
    return (value || "").replace(/[\r\n]+/g, " ").trim();
  }

  // Build the flat merge-data map from the frozen mergeSnapshot (+ email
  // fallback). mergeSnapshot is a RAW JSON STRING on the row; parse defensively.
  // We pass the WHOLE snapshot through so any church/campus/ordination keys the
  // freeze added (plan 12-02) flow to the renderer untouched — the render helper
  // reads whatever keys exist.
  private static mergeData(recipient: CampaignRecipient): Record<string, string | undefined> {
    let snap: any = {};
    try {
      snap = recipient.mergeSnapshot ? JSON.parse(recipient.mergeSnapshot) : {};
    } catch {
      snap = {};
    }
    return { ...snap, email: snap.email ?? recipient.email };
  }

  // Derive the constant-per-render footer context from the frozen snapshot. The
  // cross-tenant background worker carries no membership repo / per-request JWT to
  // look church/campus up over HTTP, so the frozen snapshot IS the source (drift-
  // free by construction). Empty until plan 12-02 enriches the freeze; the footer
  // simply omits the blank address line.
  private static renderContext(data: Record<string, string | undefined>): CampaignRenderContext {
    return {
      churchName: data.churchName,
      campusName: data.campusName,
      address1: data.address1 ?? data.campusAddress,
      address2: data.address2,
      city: data.city,
      state: data.state,
      zip: data.zip,
      country: data.country
    };
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
