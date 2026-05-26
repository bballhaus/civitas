// Regression coverage for the manifest deadline formats we've seen in
// production. Cal eProcure historically returned NULL deadlines (and so
// got excluded from /matches + daily-roundup) because Node's `new Date()`
// can't parse its "MM/DD/YYYY HH:MMAM/PM PDT" shape — see the comment in
// parse-deadline.ts.
//
// Run with: npx tsx --test src/lib/__tests__/parse-deadline.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeadline } from "../parse-deadline";

test("OpenGov ISO 8601 parses", () => {
  const d = parseDeadline("2026-06-24T06:59:00.000Z");
  assert.ok(d);
  assert.equal(d.toISOString(), "2026-06-24T06:59:00.000Z");
});

test("BidSync 'Apr 16, 2026 5:00:00 AM PDT' parses", () => {
  const d = parseDeadline("Apr 16, 2026 5:00:00 AM PDT");
  assert.ok(d);
});

test("Cal eProcure 'MM/DD/YYYY H:MMAM PDT' parses", () => {
  const d = parseDeadline("04/09/2026 10:00AM PDT");
  assert.ok(d, "caleprocure deadline must parse to a Date, not null");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 3); // April
  assert.equal(d.getDate(), 9);
  assert.equal(d.getHours(), 10);
  assert.equal(d.getMinutes(), 0);
});

test("Cal eProcure PM time parses", () => {
  const d = parseDeadline("04/03/2026 4:00PM PDT");
  assert.ok(d);
  assert.equal(d.getHours(), 16);
});

test("Cal eProcure with U+00A0 between date and time parses", () => {
  // Real samples from the manifest include a non-breaking space in
  // posted_date / sometimes deadline. Should still parse.
  const d = parseDeadline("04/03/2026  4:00PM PDT");
  assert.ok(d);
  assert.equal(d.getDate(), 3);
});

test("Cal eProcure 12:00 noon vs midnight handled", () => {
  const noon = parseDeadline("04/09/2026 12:00PM PDT");
  const midnight = parseDeadline("04/09/2026 12:00AM PDT");
  assert.ok(noon && midnight);
  assert.equal(noon.getHours(), 12);
  assert.equal(midnight.getHours(), 0);
});

test("TBD / empty / null returns null", () => {
  assert.equal(parseDeadline("TBD"), null);
  assert.equal(parseDeadline("tbd"), null);
  assert.equal(parseDeadline(""), null);
  assert.equal(parseDeadline(null), null);
  assert.equal(parseDeadline(undefined), null);
});

test("Garbage returns null instead of throwing", () => {
  assert.equal(parseDeadline("not a date"), null);
});
