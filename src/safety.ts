/**
 * Walrus storage is append-only: a stored fact can be de-indexed but its blob persists until expiry.
 * So nothing that looks like a secret or real-world personal data is ever written to memory.
 */
const PATTERNS: [string, RegExp][] = [
  ["private key", /\b(suiprivkey1[0-9a-z]{20,}|0x[0-9a-f]{64})\b/i],
  ["api key / token", /\b(sk-[a-z0-9_-]{16,}|gsk_[a-z0-9]{16,}|ghp_[a-z0-9]{20,}|xox[abp]-[a-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/i],
  ["discord token", /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b/],
  ["credential", /\b(password|passwd|pwd|secret|token|api[_-]?key|db_pass|encryption_key)\s*[:=]\s*\S+/i],
  ["email", /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/],
  ["phone number", /(?:\+?\d[\s-]?){9,14}\d/],
  ["card number", /\b(?:\d[ -]?){13,19}\b/],
];

export function findSensitive(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

export function redact(text: string): string {
  let out = text;
  for (const [label, re] of PATTERNS) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), `[${label} removed]`);
  return out;
}
