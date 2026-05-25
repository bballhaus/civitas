// User-facing read paths (matches, tracker, daily digest, RFP detail) exclude
// RFPs whose source is in this list. Scrapers keep writing all sources to
// rfp_cache — this is a UI-layer filter so the data is preserved for resume.
//
// PlanetBids: paused pending a business conversation with PB. Their `*`-gated
// attachments require per-bid Prospective Bidder enrollment (a public
// disclosure event), and without those attachments we can't reliably score
// certifications / bonding / scope. See webscraping/v2/PLANETBIDS_VENDOR_PLAN.md.

import { notLike } from "drizzle-orm";
import { rfpCache } from "@/db/schema";

export const HIDDEN_RFP_SOURCE_PREFIXES = ["planetbids_"] as const;

export function visibleRfpSourceClause() {
  return notLike(rfpCache.sourceId, "planetbids_%");
}
