/**
 * Events cache with in-memory hot cache + sessionStorage persistence.
 * TTL: 5 minutes. Prevents redundant /api/events calls across page navigations.
 */

import type { RFP } from "@/lib/rfp-matching";

const CACHE_KEY = "civitas_events_cache";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  events: RFP[];
  timestamp: number;
}

// In-memory hot cache (fastest, lost on page reload)
let memCache: CacheEntry | null = null;

function isValid(entry: CacheEntry | null): entry is CacheEntry {
  if (!entry) return false;
  return Date.now() - entry.timestamp < CACHE_TTL;
}

export function getCachedEvents(): RFP[] | null {
  // Try in-memory first
  if (isValid(memCache)) return memCache!.events;

  // Try sessionStorage
  if (typeof window !== "undefined") {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        const entry: CacheEntry = JSON.parse(raw);
        if (isValid(entry)) {
          memCache = entry; // promote to hot cache
          return entry.events;
        }
        sessionStorage.removeItem(CACHE_KEY);
      }
    } catch {
      // Ignore parse errors
    }
  }

  return null;
}

export function setCachedEvents(events: RFP[]): void {
  const entry: CacheEntry = { events, timestamp: Date.now() };
  memCache = entry;

  if (typeof window !== "undefined") {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(entry));
    } catch {
      // sessionStorage full or unavailable — in-memory still works
    }
  }
}

export function clearCachedEvents(): void {
  memCache = null;
  if (typeof window !== "undefined") {
    try {
      sessionStorage.removeItem(CACHE_KEY);
    } catch {
      // Ignore
    }
  }
}
