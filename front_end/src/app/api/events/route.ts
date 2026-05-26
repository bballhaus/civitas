import { NextResponse } from "next/server";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getS3Client, getBucket, getObjectJSON } from "@/lib/s3";
import { config } from "@/lib/config";

// All RFP data flows through the v2 manifests written by the scraping
// pipeline (webscraping/v2). Each scraper emits a manifest at
// `scrapes/v2/manifests/{source_id}/latest.json` with fully-normalized
// EnrichedEvent records — industry/capabilities/location are inferred in
// `pipeline/normalize.py`, and attachment-derived fields (NAICS codes,
// clearances, deliverables, attachment_rollup, ...) are populated by
// `pipeline/enrich.py` when PDFs are available. The route stays a thin
// passthrough.

const s3 = getS3Client();
const S3_BUCKET = getBucket();

interface V2EnrichedEvent {
  id: string;
  source_id: string;
  source_event_id: string;
  source_url: string;
  status: "open" | "closed";
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
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
  mirrored_attachments?: { filename: string; s3_key: string; original_url?: string | null }[];
  clearances_required: string[];
  set_aside_types: string[];
  deliverables: string[];
  contract_duration: string | null;
  evaluation_criteria: string[];
  attachment_rollup: { summary: string; text: string; pdfsProcessed: string[] } | null;
  incumbent_vendor?: string;
  incumbent_contract_end?: string;
  posted_date: string | null;
  scraped_at: string;
}

interface V2Manifest {
  source_id: string;
  source_name: string;
  updated_at: string;
  total_events: number;
  events: V2EnrichedEvent[];
}

const S3_CACHE_TTL = config.cache.s3TtlMs;

let v2Cache: { manifests: V2Manifest[]; timestamp: number } | null = null;

async function loadV2Manifests(): Promise<V2Manifest[]> {
  const now = Date.now();
  if (v2Cache && now - v2Cache.timestamp < S3_CACHE_TTL) {
    return v2Cache.manifests;
  }

  try {
    const listCmd = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: "scrapes/v2/manifests/",
      Delimiter: "/",
    });
    const listResp = await s3.send(listCmd);
    const prefixes = listResp.CommonPrefixes?.map(p => p.Prefix).filter(Boolean) ?? [];

    const manifests: V2Manifest[] = [];
    for (const prefix of prefixes) {
      const key = `${prefix}latest.json`;
      const manifest = await getObjectJSON<V2Manifest>(key);
      if (manifest && manifest.events?.length > 0) {
        manifests.push(manifest);
      }
    }

    v2Cache = { manifests, timestamp: now };

    // rfp_cache mirroring now happens at scrape time: the Lambda calls
    // /api/cron/sync-rfp-cache after each batch, which upserts rows and
    // refreshes embeddings. The read path no longer needs the workaround.

    return manifests;
  } catch (err) {
    console.warn("Could not load v2 manifests:", err);
    return [];
  }
}

function v2EventToRfp(e: V2EnrichedEvent) {
  return {
    id: e.id,
    title: e.title,
    agency: e.agency,
    location: e.location,
    deadline: e.deadline,
    estimatedValue: e.estimated_value,
    industry: e.industry,
    naicsCodes: e.naics_codes,
    capabilities: e.capabilities,
    certifications: e.certifications,
    contractType: e.procurement_type || "RFx",
    description: e.description,
    eventUrl: e.source_url,
    contactName: e.contact?.name,
    contactEmail: e.contact?.email,
    contactPhone: e.contact?.phone,
    attachmentUrls: e.attachment_urls || [],
    mirroredAttachments: (e.mirrored_attachments || []).map((m) => ({
      filename: m.filename,
      s3Key: m.s3_key,
      originalUrl: m.original_url ?? null,
    })),
    clearancesRequired: e.clearances_required,
    setAsideTypes: e.set_aside_types,
    deliverables: e.deliverables,
    contractDuration: e.contract_duration,
    evaluationCriteria: e.evaluation_criteria,
    attachmentRollup: e.attachment_rollup,
    incumbentVendor: e.incumbent_vendor ?? null,
    incumbentContractEnd: e.incumbent_contract_end ?? null,
    firstSeenAt: e.first_seen_at ?? null,
    sourceId: e.source_id,
  };
}

// Pick the "richer" of two duplicate RFPs (same title across sources). We
// prefer the one with an attachment_rollup (i.e. LLM-enriched), and break
// ties with attachment_urls present. This protects us when a portal
// migrates and the same RFP shows up under two source_ids during overlap.
function richnessScore(rfp: ReturnType<typeof v2EventToRfp>): number {
  let s = 0;
  if (rfp.attachmentRollup?.summary || rfp.attachmentRollup?.text) s += 10;
  if (rfp.deliverables?.length) s += 4;
  if (rfp.naicsCodes?.length) s += 3;
  if (rfp.attachmentUrls?.length) s += 2;
  if (rfp.evaluationCriteria?.length) s += 1;
  return s;
}

export async function GET() {
  try {
    const manifests = await loadV2Manifests();
    if (manifests.length === 0) {
      return NextResponse.json(
        { error: "No RFP manifests available" },
        { status: 500 }
      );
    }

    const all = manifests.flatMap((m) =>
      m.events
        .filter((e) => !!e.title?.trim())
        .filter((e) => e.status !== "closed")
        .map(v2EventToRfp)
    );

    // Deduplicate by normalized title — same RFP can appear on multiple
    // portals (e.g. legacy caleprocure detail page + an OpenGov listing).
    // When duplicates collide, keep the richer record.
    const byKey = new Map<string, ReturnType<typeof v2EventToRfp>>();
    for (const rfp of all) {
      const key = rfp.title.toLowerCase().trim().replace(/\s+/g, " ");
      const existing = byKey.get(key);
      if (!existing || richnessScore(rfp) > richnessScore(existing)) {
        byKey.set(key, rfp);
      }
    }
    const deduped = Array.from(byKey.values());

    return NextResponse.json(
      { events: deduped, total: deduped.length },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      }
    );
  } catch (err) {
    console.error("Error loading events:", err);
    return NextResponse.json(
      { error: "Failed to load events", details: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
