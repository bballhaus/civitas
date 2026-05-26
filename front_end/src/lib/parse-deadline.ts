// Shared deadline parser for RFP timestamps coming off the v2 manifests.
//
// Each portal emits its own format; `new Date(str)` is permissive enough
// for ISO 8601 (OpenGov) and the "Apr 16, 2026 5:00:00 AM PDT" shape
// (BidSync) but silently returns Invalid Date for Cal eProcure's
// "04/09/2026 10:00AM PDT" (no space before AM/PM; sometimes a U+00A0
// between the date and time). Falling back to a regex catches that case
// so the populator doesn't write NULL deadlines for every caleprocure row
// — which would silently exclude them from /matches and the daily digest.

export function parseDeadline(deadline: string | null | undefined): Date | null {
  const normalized = deadline?.trim();
  if (!normalized || normalized.toUpperCase() === "TBD") return null;

  const direct = Date.parse(normalized);
  if (!Number.isNaN(direct)) return new Date(direct);

  const cleaned = normalized
    .replace(/\b(PST|PDT)\b/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const m = cleaned.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(AM|PM)$/i,
  );
  if (!m) return null;

  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  let hh = Number(m[4]);
  const ampm = m[6].toUpperCase();

  if (ampm === "PM" && hh !== 12) hh += 12;
  if (ampm === "AM" && hh === 12) hh = 0;

  return new Date(yyyy, mm - 1, dd, hh, Number(m[5]), 0);
}
