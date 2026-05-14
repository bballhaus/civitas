// rfp_cache populator (Architecture-v2 § 3, § 11).
//
// Reads v2 webscraping manifests from S3 and upserts into the rfp_cache
// Postgres table so the v2 matcher (matching-v2.ts) has data to score
// against. The matcher operates on the Drizzle schema; this module is
// the bridge between scrapes that land in S3 and the relational shape
// the matcher expects.
//
// Idempotent: keyed on rfp_cache.id (the same id used in S3 manifests).
// Safe to re-run; ON CONFLICT DO UPDATE replaces the row.
//
// Usage:
//   - CLI (one-off backfill / cron):
//       npx tsx src/lib/rfp-cache-populator.ts
//   - From server code (e.g. wired into GET /api/events for write-through):
//       await populateRfpCacheFromV2Manifests();

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { db } from "@/db/client";
import { rfpCache, rfpBidders } from "@/db/schema";
import { getS3Client, getBucket, getObjectJSON } from "@/lib/s3";
import { sql } from "drizzle-orm";

// Same shape as the V2EnrichedEvent in app/api/events/route.ts. Repeated
// here so the populator can live without depending on Next.js route code.
interface V2EnrichedEvent {
  id: string;
  source_id: string;
  source_event_id: string;
  source_url: string;
  status: "open" | "closed";
  title: string;
  description: string;
  agency: string;
  location: string;
  deadline: string;
  estimated_value: string;
  industry: string;
  procurement_type: string;
  naics_codes: string[];
  capabilities: string[];
  certifications: string[];
  contact: { name?: string; email?: string; phone?: string };
  attachment_urls: string[];
  clearances_required: string[];
  set_aside_types: string[];
  deliverables: string[];
  contract_duration: string | null;
  evaluation_criteria: string[];
  attachment_rollup: {
    summary: string;
    text: string;
    pdfsProcessed: string[];
  } | null;
  posted_date: string | null;
  scraped_at: string;
  // Optional market-intel fields (PlanetBids). Manifests vary by source.
  prospective_bidders?: { name: string; classification?: string }[];
  bid_results?: {
    name: string;
    bid_amount?: number;
    responsive?: boolean;
  }[];
  award?: { winner: string; winning_bid?: number };
  incumbent_vendor?: string;
  requires_past_gov_experience?: boolean;
}

interface V2Manifest {
  source_id: string;
  source_name: string;
  updated_at: string;
  total_events: number;
  events: V2EnrichedEvent[];
}

// Cents conversion helper for monetary fields. Source values are dollars.
function dollarsToCents(usd: number | undefined | null): number | null {
  if (usd == null || Number.isNaN(usd)) return null;
  return Math.round(usd * 100);
}

// Parse "$5M", "$1,500,000", "Estimated: $250,000-$500,000". Returns the
// max when ranges appear. Falls back to null on anything weird.
function parseEstimatedUsd(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,$\s]/g, "");
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*([KMB])?/gi);
  if (!match) return null;
  // Take the largest number — handles "$5M-$10M" → 10M.
  let best = 0;
  for (const tok of match) {
    const m = tok.match(/(\d+(?:\.\d+)?)([KMB])?/i);
    if (!m) continue;
    let v = parseFloat(m[1]);
    const suffix = (m[2] || "").toUpperCase();
    if (suffix === "K") v *= 1_000;
    else if (suffix === "M") v *= 1_000_000;
    else if (suffix === "B") v *= 1_000_000_000;
    best = Math.max(best, v);
  }
  return best > 0 ? Math.round(best) : null;
}

function parseDeadline(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function eventToCacheRow(e: V2EnrichedEvent) {
  return {
    id: e.id,
    sourceId: e.source_id,
    title: e.title,
    description: e.description ?? null,
    agency: e.agency ?? null,
    location: e.location ?? null,
    deadline: parseDeadline(e.deadline),
    estimatedValueUsd: parseEstimatedUsd(e.estimated_value),
    capabilities: e.capabilities ?? null,
    naicsCodes: e.naics_codes ?? null,
    certificationsRequired: e.certifications ?? null,
    licensesRequired: extractLicenseClasses(e),
    setAsideLockout: e.set_aside_types ?? null,
    deliverables: e.deliverables ?? null,
    requiresPastGovExp: e.requires_past_gov_experience ?? null,
    incumbentVendor: e.incumbent_vendor ?? null,
    incumbentContractEnd: null,
    prospectiveBidderCount: e.prospective_bidders?.length ?? null,
    bidCount: e.bid_results?.length ?? null,
    bidAmountsCents:
      e.bid_results
        ?.map((b) => dollarsToCents(b.bid_amount))
        .filter((c): c is number => c != null) ?? null,
    winningBidCents: dollarsToCents(e.award?.winning_bid),
    winningVendorFingerprint: null, // resolved later by vendor index
    embedding: null, // populated by refreshRfpEmbeddings()
    raw: e as unknown as Record<string, unknown>,
    refreshedAt: new Date(),
  };
}

// License classes are not always a first-class field on the manifest;
// when present, they live in certifications[] mixed with set-asides.
// Pull anything that looks like a CSLB class out into licensesRequired.
function extractLicenseClasses(e: V2EnrichedEvent): string[] | null {
  const all = [...(e.certifications ?? []), ...(e.set_aside_types ?? [])];
  if (all.length === 0) return null;
  const out = all
    .map((s) => {
      const m = s.toUpperCase().match(/(?:CLASS\s+)?([A-Z](?:[-\s]?\d{1,2})?)\b/);
      if (!m) return null;
      // Heuristic: single-letter "A"/"B" or "C-XX" or "C-X" — looks like CSLB.
      const cls = m[1].replace(/\s+/g, "-");
      if (/^[AB]$/.test(cls) || /^C-\d{1,2}$/.test(cls) || cls === "PE" || cls === "DIR") {
        return cls;
      }
      return null;
    })
    .filter((c): c is string => !!c);
  return out.length > 0 ? Array.from(new Set(out)) : null;
}

async function listSourcePrefixes(s3: ReturnType<typeof getS3Client>, bucket: string) {
  const cmd = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: "scrapes/v2/manifests/",
    Delimiter: "/",
  });
  const resp = await s3.send(cmd);
  return resp.CommonPrefixes?.map((p) => p.Prefix).filter((p): p is string => !!p) ?? [];
}

export interface PopulatorResult {
  manifestsRead: number;
  eventsTotal: number;
  rowsUpserted: number;
  biddersInserted: number;
}

export async function populateRfpCacheFromV2Manifests(): Promise<PopulatorResult> {
  const s3 = getS3Client();
  const bucket = getBucket();
  const prefixes = await listSourcePrefixes(s3, bucket);

  let manifestsRead = 0;
  let eventsTotal = 0;
  let rowsUpserted = 0;
  let biddersInserted = 0;

  for (const prefix of prefixes) {
    const key = `${prefix}latest.json`;
    const manifest = await getObjectJSON<V2Manifest>(key);
    if (!manifest || !Array.isArray(manifest.events)) continue;
    manifestsRead += 1;
    eventsTotal += manifest.events.length;

    // Upsert in batches of 50 so very large manifests don't blow up the
    // INSERT statement size limits.
    const BATCH = 50;
    for (let i = 0; i < manifest.events.length; i += BATCH) {
      const slice = manifest.events.slice(i, i + BATCH);
      const rows = slice.map(eventToCacheRow);

      await db
        .insert(rfpCache)
        .values(rows)
        .onConflictDoUpdate({
          target: rfpCache.id,
          set: {
            sourceId: sql`excluded.source_id`,
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            agency: sql`excluded.agency`,
            location: sql`excluded.location`,
            deadline: sql`excluded.deadline`,
            estimatedValueUsd: sql`excluded.estimated_value_usd`,
            capabilities: sql`excluded.capabilities`,
            naicsCodes: sql`excluded.naics_codes`,
            certificationsRequired: sql`excluded.certifications_required`,
            licensesRequired: sql`excluded.licenses_required`,
            setAsideLockout: sql`excluded.set_aside_lockout`,
            deliverables: sql`excluded.deliverables`,
            requiresPastGovExp: sql`excluded.requires_past_gov_exp`,
            incumbentVendor: sql`excluded.incumbent_vendor`,
            prospectiveBidderCount: sql`excluded.prospective_bidder_count`,
            bidCount: sql`excluded.bid_count`,
            bidAmountsCents: sql`excluded.bid_amounts_cents`,
            winningBidCents: sql`excluded.winning_bid_cents`,
            raw: sql`excluded.raw`,
            refreshedAt: sql`excluded.refreshed_at`,
            // Note: embedding is NOT replaced — keep prior value until
            // refreshRfpEmbeddings() recomputes it.
          },
        });
      rowsUpserted += rows.length;

      // Fan out bidders for the cross-event signal table.
      const bidderRows = [];
      for (const e of slice) {
        for (const b of e.prospective_bidders ?? []) {
          bidderRows.push({
            rfpId: e.id,
            vendorFingerprint: null,
            vendorName: b.name,
            role: "prospective" as const,
            bidAmountCents: null,
            responsive: null,
            classification: b.classification ?? null,
          });
        }
        for (const b of e.bid_results ?? []) {
          bidderRows.push({
            rfpId: e.id,
            vendorFingerprint: null,
            vendorName: b.name,
            role: "bidder" as const,
            bidAmountCents: dollarsToCents(b.bid_amount),
            responsive: b.responsive ?? null,
            classification: null,
          });
        }
        if (e.award?.winner) {
          bidderRows.push({
            rfpId: e.id,
            vendorFingerprint: null,
            vendorName: e.award.winner,
            role: "winner" as const,
            bidAmountCents: dollarsToCents(e.award.winning_bid),
            responsive: true,
            classification: null,
          });
        }
      }
      if (bidderRows.length > 0) {
        // Bidders are append-only — we don't have a stable unique key per
        // bidder beyond (rfp_id, vendor_name, role) and the matcher tolerates
        // duplicates. To avoid runaway growth on repeated runs, we delete
        // the previous fan-out for this batch's RFPs first.
        await db.delete(rfpBidders).where(
          sql`${rfpBidders.rfpId} IN (${sql.join(
            slice.map((e) => sql`${e.id}`),
            sql`, `,
          )})`,
        );
        await db.insert(rfpBidders).values(bidderRows);
        biddersInserted += bidderRows.length;
      }
    }
  }

  return { manifestsRead, eventsTotal, rowsUpserted, biddersInserted };
}

// CLI entry — `npx tsx src/lib/rfp-cache-populator.ts`
const isCli =
  typeof require !== "undefined" && require.main === module;
if (isCli) {
  populateRfpCacheFromV2Manifests()
    .then((r) => {
      console.log("[rfp-cache] populator finished:", r);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[rfp-cache] populator failed:", err);
      process.exit(1);
    });
}
