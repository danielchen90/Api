import { MergeFieldHelper } from "./MergeFieldHelper.js";
import { EmailCampaign } from "../models/index.js";

// The ONE server-side renderer (Phase 12 load-bearing decision). Preview,
// test-send, and real send ALL call CampaignRenderHelper.render so the merged
// bytes are byte-identical by construction — zero compose->send drift.
//
// Pipeline (order matters):
//   1. base body   = campaign.renderedHtml (Unlayer export, already stored)
//   2. STRIP       = defensively remove any trailing Unlayer branding block
//   3. FOOTER      = append the non-removable CAN-SPAM/Huro footer (with the
//                    reserved {{unsubscribeUrl}} placeholder slot — Phase 14 swaps
//                    in the real one-click URL)
//   4. MERGE       = MergeFieldHelper.resolve over html + subject + preheader
//   5. TEXT PART   = derive a plain-text part from the merged html (DLV-05: a text
//                    part MUST always exist)
// Subject is CR/LF-sanitized at render time (Pitfall 6 — header injection defense).

// Constant-per-campaign context loaded ONCE by the caller (never per recipient):
// church name, campus name, and the campus physical-address fields used in the
// compliant footer (CAN-SPAM physical address).
export interface CampaignRenderContext {
  churchName?: string;
  campusName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface CampaignRenderResult {
  html: string;
  text: string;
  subject: string;
}

export class CampaignRenderHelper {

  // The placeholder value the reserved {{unsubscribeUrl}} slot resolves to NOW.
  // Phase 14 replaces this with the real one-click List-Unsubscribe URL. Merging
  // it (rather than leaving a raw token) means the sent HTML never leaks a literal
  // `{{unsubscribeUrl}}` — it carries a benign anchor href.
  private static readonly UNSUBSCRIBE_PLACEHOLDER = "#unsubscribe-pending";

  static async render(
    campaign: EmailCampaign,
    mergeData: Record<string, string | undefined>,
    context: CampaignRenderContext,
    preheader?: string
  ): Promise<CampaignRenderResult> {
    // 1. Base body.
    const base = campaign.renderedHtml || "";

    // 2. Strip any Unlayer-injected branding block. Conservative: only remove a
    //    block that carries a known Unlayer signature. We never send Unlayer's
    //    raw export as-is (Pitfall 1 — the hard no-vendor-branding guarantee).
    const stripped = CampaignRenderHelper.stripUnlayerBranding(base);

    // 3. Append the non-removable compliant footer AFTER the strip.
    const footered = stripped + CampaignRenderHelper.buildFooter(context);

    // Reserve the {{unsubscribeUrl}} slot with a placeholder so the merge pass
    // leaves a benign value (Phase 14 swaps the real URL). Person/church/campus
    // keys already live in mergeData; add the placeholder without mutating caller.
    const dataWithUnsub: Record<string, string | undefined> = {
      ...mergeData,
      unsubscribeUrl: mergeData.unsubscribeUrl ?? CampaignRenderHelper.UNSUBSCRIBE_PLACEHOLDER
    };

    // 4. Merge over html, subject, and preheader (all just templates).
    const html = MergeFieldHelper.resolve(footered, dataWithUnsub);
    const subject = CampaignRenderHelper.sanitizeHeader(
      MergeFieldHelper.resolve(campaign.subject || "", dataWithUnsub)
    );
    // Preheader is merged for completeness/callers that surface it (not injected
    // into html here — the client already positions the preheader block).
    void MergeFieldHelper.resolve(preheader || "", dataWithUnsub);

    // 5. Text part from the MERGED html so it matches the sent HTML, then re-merge
    //    is unnecessary (html already merged). A text part MUST always exist.
    const rawText = (campaign.renderedText && campaign.renderedText.trim().length > 0)
      ? MergeFieldHelper.resolve(campaign.renderedText, dataWithUnsub)
      : CampaignRenderHelper.htmlToText(html);
    const text = rawText.trim().length > 0 ? rawText : CampaignRenderHelper.htmlToText(html);

    return { html, text, subject };
  }

  // Build the non-removable footer. Huro muted text (#6B7280) on ivory (#F5F6F7).
  // Carries: churchName (· campusName if present), the campus physical address
  // line (CAN-SPAM), the reserved {{unsubscribeUrl}} anchor, and the sign-off.
  static buildFooter(ctx: CampaignRenderContext): string {
    const churchName = ctx.churchName || "";
    const campusPart = ctx.campusName ? " &middot; " + ctx.campusName : "";
    const addressLine = [ctx.address1, ctx.address2, ctx.city, ctx.state, ctx.zip, ctx.country]
      .filter((p) => p && String(p).trim().length > 0)
      .join(" ");
    return `
<table role="presentation" width="100%" style="border-collapse:collapse"><tr><td style="text-align:center;color:#6B7280;font-size:12px;line-height:18px;padding:16px;background:#F5F6F7">
  ${churchName}${campusPart}<br/>
  ${addressLine}<br/>
  <a href="{{unsubscribeUrl}}" style="color:#6B7280">Unsubscribe</a> &middot; Sent with Huro
</td></tr></table>`;
  }

  // Defensively strip a trailing Unlayer branding block. Free-tier Unlayer may
  // append a "Powered by Unlayer" block near the document tail. We remove ONLY a
  // block that carries the known signature (case-insensitive "unlayer") — we do
  // NOT strip arbitrary content. Two conservative passes:
  //   (a) an anchor/table/div block whose inner text mentions "Powered by Unlayer"
  //   (b) any leftover standalone "Powered by Unlayer" text node
  static stripUnlayerBranding(html: string): string {
    if (!html) return "";
    let out = html;
    // (a) A wrapping row/table/div/anchor that contains the branding phrase.
    out = out.replace(
      /<(table|tr|td|div|a|p)\b[^>]*>(?:(?!<\/\1>)[\s\S])*?Powered by Unlayer[\s\S]*?<\/\1>/gi,
      ""
    );
    // (b) Any residual bare branding phrase.
    out = out.replace(/Powered by Unlayer/gi, "");
    return out;
  }

  // Strip CR/LF from a header-bound value (subject) — header-injection defense
  // (Pitfall 6). Promoted from CampaignSendWorker so preview/test/real share it.
  static sanitizeHeader(value?: string): string {
    return (value || "").replace(/[\r\n]+/g, " ").trim();
  }

  // Minimal HTML->text fallback so a text part always exists (DLV-05). Promoted
  // from CampaignSendWorker into this shared helper. Strip scripts/styles, turn
  // block boundaries into newlines, drop tags, decode a few entities, collapse
  // whitespace.
  static htmlToText(html: string): string {
    return (html || "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>(?=)/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&middot;/gi, "·")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
