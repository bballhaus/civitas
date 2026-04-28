"use client";

import { useEffect } from "react";
import { initEventTracker } from "@/lib/event-tracker";

/**
 * Mounts once at the root of the app to wire up the client-side KPI event
 * tracker (periodic flush, sendBeacon on tab hide / unload). Renders nothing.
 */
export function KpiInit() {
  useEffect(() => {
    initEventTracker();
  }, []);
  return null;
}
