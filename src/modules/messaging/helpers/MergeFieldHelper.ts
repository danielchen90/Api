// The SINGLE merge-field substitution engine (BLD-03 / BLD-04 server half).
// One generic {{key|fallback}} regex over a flat string→string data map, with
// HTML-escaped substitution. Used identically over html / subject / preheader by
// CampaignRenderHelper so preview, test-send, and real send never drift.
//
// SINGLE-ENGINE DOCTRINE: do NOT add a second resolver — extend here. The literal
// pass-through mergeTags the Unlayer client emits (e.g. value:"{{firstName|Friend}}")
// survive export verbatim; ALL interpretation happens here, server-side.

// The three merge-field categories the client mergeTags (plan 12-05) and the
// render helper (Task 2) populate. Keys are BARE (no braces) — they are the
// capture group of the {{key|fallback}} regex and the keys of the merge data map.
export interface MergeFieldDef {
  key: string;
  label: string;
  category: "person" | "church" | "ordination";
}

// HTML-escape map for substituted values — O'Brien / < / & / " never corrupt the
// rendered HTML (Pitfall: un-escaped merge values). Applied to the SUBSTITUTED
// value only, never to the surrounding template markup.
const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

// Back-compat shape for existing callers that pass a typed person object. A
// MergeFieldPerson is a valid Record<string, string | undefined>.
export interface MergeFieldPerson {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  [key: string]: string | undefined;
}

export class MergeFieldHelper {

  // Enumerates the merge fields exposed to the client, grouped by the three
  // categories. `key` is the BARE key (matches the render-helper mergeData keys
  // and the {{key}} capture group). The client wraps these into {{key}} /
  // {{key|fallback}} mergeTags (plan 12-05).
  static availableFields: MergeFieldDef[] = [
    // Person basics
    { key: "firstName", label: "First Name", category: "person" },
    { key: "lastName", label: "Last Name", category: "person" },
    { key: "displayName", label: "Display Name", category: "person" },
    { key: "email", label: "Email", category: "person" },
    // Church / campus
    { key: "churchName", label: "Church Name", category: "church" },
    { key: "campusName", label: "Campus Name", category: "church" },
    { key: "campusAddress", label: "Campus Address", category: "church" },
    // Ordination / credential
    { key: "ordinationTitle", label: "Ordination Title", category: "ordination" },
    { key: "credentialNumber", label: "Credential Number", category: "ordination" },
    { key: "ordinationStatus", label: "Ordination Status", category: "ordination" }
  ];

  // Generic {{key|fallback}} resolver with HTML-escaped substitution.
  // - Regex captures a dotted/word key and an optional |fallback (everything up to
  //   the closing braces).
  // - Look up data[key]; if null/undefined/empty-string, use the fallback (?? "").
  // - HTML-escape the resulting value so it is safe inside the rendered HTML.
  // Works over ANY template string — body html, subject, and preheader alike.
  static resolve(template: string, data: Record<string, string | undefined>): string {
    return (template || "").replace(/\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g, (_m, key: string, fb?: string) => {
      const raw = data[key];
      const val = (raw != null && String(raw).length > 0) ? String(raw) : (fb ?? "");
      return val.replace(/[&<>"']/g, (c) => ESC[c]);
    });
  }

  // Sample-render for previews with placeholder data (unchanged behavior; now a
  // thin wrapper over the generic resolve with a flat sample map).
  static resolveSample(template: string, churchName?: string): string {
    return this.resolve(template, {
      firstName: "John",
      lastName: "Smith",
      displayName: "John Smith",
      email: "john@example.com",
      churchName: churchName || "Your Church"
    });
  }

}
