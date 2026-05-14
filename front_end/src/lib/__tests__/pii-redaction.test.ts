// Quick sanity coverage for the PII redaction layer. Not a substitute for
// running real contractor uploads through it, but catches the obvious
// regressions when someone touches the rule order.
//
// Run with: npx tsx --test src/lib/__tests__/pii-redaction.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactPii } from "../pii-redaction";

test("SSN", () => {
  const out = redactPii("SSN is 123-45-6789 on file.");
  assert.equal(out.text, "SSN is [REDACTED-SSN] on file.");
  assert.equal(out.counts.SSN, 1);
});

test("EIN", () => {
  const out = redactPii("Tax ID 12-3456789 belongs to Acme.");
  assert.equal(out.text, "Tax ID [REDACTED-EIN] belongs to Acme.");
});

test("phone numbers in multiple shapes", () => {
  const out = redactPii(
    "Call (415) 555-1234 or 415.555.5678 or +1 415 555 9999.",
  );
  assert.match(out.text, /Call \[REDACTED-PHONE\] or \[REDACTED-PHONE\] or \[REDACTED-PHONE\]\./);
  assert.equal(out.counts.PHONE, 3);
});

test("email", () => {
  const out = redactPii("Contact bob.smith+civitas@example.co.uk for details.");
  assert.equal(out.text, "Contact [REDACTED-EMAIL] for details.");
});

test("CA driver license shape", () => {
  const out = redactPii("DL: A1234567 expires 2027.");
  assert.match(out.text, /\[REDACTED-DL\]/);
});

test("signature name preservation of label", () => {
  const out = redactPii("Signature: Jane Q. Doe");
  assert.equal(out.text, "Signature: [REDACTED-NAME]");
});

test("bank account requires nearby context", () => {
  // Long numeric without context — should NOT be redacted (false positive
  // risk on zip codes, invoice numbers, contract IDs).
  const a = redactPii("Invoice 1234567890 due Friday.");
  assert.equal(a.text, "Invoice 1234567890 due Friday.");
  assert.equal(a.total, 0);

  // Same number with "account" nearby — should be redacted.
  const b = redactPii("Wire to account 1234567890 routing 021000021.");
  assert.match(b.text, /account \[REDACTED-ACCT\]/);
});
