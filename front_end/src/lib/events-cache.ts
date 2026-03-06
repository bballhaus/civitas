/**
 * In-memory cache for /api/events so dashboard and RFP detail page
 * can show data instantly when the user has already loaded events (e.g. on home).
 */

import type { RFP } from "@/lib/rfp-matching";

let cached: RFP[] | null = null;

export function getCachedEvents(): RFP[] | null {
  return cached;
}

export function setCachedEvents(events: RFP[]): void {
  cached = events;
}

export function clearCachedEvents(): void {
  cached = null;
}
