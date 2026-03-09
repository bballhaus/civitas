/**
 * In-memory + localStorage cache for /api/events so dashboard loads instantly on refresh.
 * Persists across page reloads with 30-min TTL.
 */

import type { RFP } from "@/lib/rfp-matching";

const STORAGE_KEY = "civitas_events_cache";
const TTL_MS = 30 * 60 * 1000; // 30 minutes

let cached: RFP[] | null = null;

export function getCachedEvents(): RFP[] | null {
  if (cached && cached.length > 0) return cached;
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw) as { data: RFP[]; timestamp: number };
    if (!Array.isArray(data) || data.length === 0) return null;
    if (Date.now() - timestamp > TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    cached = data;
    return data;
  } catch {
    return null;
  }
}

export function setCachedEvents(events: RFP[]): void {
  cached = events;
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ data: events, timestamp: Date.now() }));
  } catch {
    // localStorage full or disabled
  }
}

export function clearCachedEvents(): void {
  cached = null;
  if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY);
}
