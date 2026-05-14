// PII redaction layer (Architecture-v2 § 7).
//
// Pre-LLM regex pass on extracted document text. Replaces matches with typed
// placeholders so the LLM still sees document structure but no longer sees
// raw identifiers. Run BEFORE the 50K-char truncation in the extractor so
// we never redact only part of a redactable string.
//
// Order matters: longer / more-specific patterns first, then short ones.
// Bank-account checks require context, so they're guarded against false
// positives (zip codes, invoice numbers).

export interface PiiRedactionResult {
  text: string;
  // Count by type so contracts.pii_redacted_count can be a single integer
  // while we still surface diagnostic detail in logs.
  counts: Record<string, number>;
  total: number;
}

interface Rule {
  type: string;
  // RegExp must be sticky-free + global so .replace() walks the whole string.
  pattern: RegExp;
  // Optional check on the match; returns true to redact, false to leave alone.
  // Used for bank-account-style numerics where context disambiguates.
  guard?: (match: string, fullText: string, offset: number) => boolean;
  placeholder: string;
}

// Bank-account guard: 8-17 contiguous digits. Reject if the surrounding text
// suggests something else (zip codes have 5 or 9 digits; phone groups already
// matched earlier; pure-numeric IDs in tables are noisy).
function isLikelyBankAccount(match: string, full: string, offset: number): boolean {
  if (match.length < 8 || match.length > 17) return false;
  // Look at ~30 chars before the match for "account", "routing", "acct",
  // "iban" — the words people use right next to actual bank numbers.
  const ctx = full.slice(Math.max(0, offset - 40), offset).toLowerCase();
  return /\b(account|acct|routing|iban|aba)\b/.test(ctx);
}

const RULES: Rule[] = [
  {
    type: "SSN",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    placeholder: "[REDACTED-SSN]",
  },
  {
    type: "EIN",
    pattern: /\b\d{2}-\d{7}\b/g,
    placeholder: "[REDACTED-EIN]",
  },
  {
    type: "PHONE",
    // US-shaped. Require either explicit parens or at least one separator
    // between groups; otherwise a bare 10-digit invoice number (or any
    // long numeric ID) matches and gets nuked.
    pattern:
      /(?:\+?1[-.\s])?(?:\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4})/g,
    placeholder: "[REDACTED-PHONE]",
  },
  {
    type: "EMAIL",
    pattern: /[\w.+\-]+@[\w-]+\.[\w.-]+/g,
    placeholder: "[REDACTED-EMAIL]",
  },
  {
    type: "DL",
    // CA driver-license shape: letter followed by 7-8 digits.
    pattern: /\b[A-Z]\d{7,8}\b/g,
    placeholder: "[REDACTED-DL]",
  },
  {
    type: "SIGNATURE_NAME",
    // "Signature: Jane Doe" — redact the trailing name.
    pattern: /(Signature:\s*)([A-Za-z][A-Za-z'.\-]+(?:\s+[A-Za-z][A-Za-z'.\-]+){0,3})/g,
    placeholder: "$1[REDACTED-NAME]",
  },
  {
    type: "BANK_ACCT",
    pattern: /\b\d{8,17}\b/g,
    guard: isLikelyBankAccount,
    placeholder: "[REDACTED-ACCT]",
  },
];

export function redactPii(text: string): PiiRedactionResult {
  const counts: Record<string, number> = {};
  let working = text;

  for (const rule of RULES) {
    let localCount = 0;
    working = working.replace(rule.pattern, (match, ...rest) => {
      // rest = [...captureGroups, offset, fullString, namedGroups?]
      // offset is the second-to-last numeric arg before fullString. Easiest:
      // grab the trailing string for full text + the preceding number for offset.
      const fullText = rest[rest.length - 1] as string;
      const offset = rest[rest.length - 2] as number;
      if (rule.guard && !rule.guard(match, fullText, offset)) {
        return match;
      }
      localCount += 1;
      // Replace-with-placeholder respects backreferences inside placeholder
      // (used by SIGNATURE_NAME to preserve the "Signature:" prefix).
      if (rule.placeholder.includes("$")) {
        // Two-capture-group rule — return the literal expansion.
        return match.replace(rule.pattern, rule.placeholder);
      }
      return rule.placeholder;
    });
    if (localCount > 0) counts[rule.type] = localCount;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text: working, counts, total };
}
