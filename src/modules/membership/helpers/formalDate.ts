// formalDate.ts — the "formal English" date formatter (net-new, Quick-5).
//
// KEEP IN SYNC WITH forks/B1Admin/src/licenseTemplates/helpers/formalDate.ts.
// This is the SERVER mirror. The editor preview (the B1Admin copy, via
// bindings.resolveBinding) and the server PDF (this copy, via
// renderBindings.resolveBinding) MUST produce byte-identical strings for the
// reserved dateFormat sentinel "[FORMAL]" — that is the fidelity invariant the
// whole feature rides on. Any divergence = preview != print.
//
// Renders a "YYYY-MM-DD" (or any dayjs-parseable) date as "January 15th, 2024":
// full month name + ordinal day (1st/2nd/3rd/4th…11th…21st…) + ", " + 4-digit year.
// Pure — no dayjs; parses the Y-M-D parts directly. Empty/invalid => "".

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// English ordinal suffix: 11/12/13 are always "th"; otherwise by last digit.
const ordinalSuffix = (n: number): string => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
};

export const formatFormalDate = (iso: string): string => {
  if (!iso) return "";
  // Accept "YYYY-MM-DD" (optionally with a T… time suffix) — take the date part only.
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(iso).trim());
  if (!m) return "";
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${MONTHS[month - 1]} ${day}${ordinalSuffix(day)}, ${year}`;
};
