// Tiny LOCAL email validator (AUD-05). RESEARCH: @churchapps/apihelper has no
// isValidEmail, and RFC-perfect validation is a rabbit hole — AUD-05 only needs
// to skip-and-report OBVIOUSLY-bad addresses, so this is deliberately lenient.
// NO email library is pulled in.

export function normalizeEmail(raw?: string | null): string {
  return (raw ?? "").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  // Exactly one @, a non-empty local part, and a dot in the domain. Lenient.
  if (!email) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const domain = email.slice(at + 1);
  return domain.length >= 3 && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}
