"use client";

import { useEffect } from "react";
import { setCachedEvents } from "@/lib/events-cache";
import type { RFP } from "@/lib/rfp-matching";

/**
 * Prefetches /api/events in the background as soon as the app mounts,
 * so dashboard and RFP detail page can use cached data and feel instant.
 */
export function PrefetchEvents() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    fetch("/api/events")
      .then((res) => (res.ok ? res.json() : { events: [] }))
      .then((data) => {
        const events = (data.events ?? []) as RFP[];
        if (events.length > 0) setCachedEvents(events);
      })
      .catch(() => {
        // ignore; pages will fetch on demand
      });
  }, []);
  return null;
}
