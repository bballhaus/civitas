/**
 * Client-side KPI event tracker.
 *
 * Buffers events in memory and flushes them in batches to /api/events/track:
 *   - on a 10-second interval
 *   - when the buffer hits MAX_BUFFER
 *   - on visibilitychange (tab hidden) via navigator.sendBeacon
 *   - on pagehide via navigator.sendBeacon
 *
 * Best-effort: failed flushes are dropped silently. KPI tracking must never
 * affect the user-facing UX.
 */
"use client";

import type { ClientEventType, EventPayload, TrackedEvent } from "./events";

const FLUSH_INTERVAL_MS = 10_000;
const MAX_BUFFER = 50;
const ENDPOINT = "/api/events/track";

interface TrackerState {
  initialized: boolean;
  sessionId: string | null;
  queue: TrackedEvent[];
  flushTimer: ReturnType<typeof setInterval> | null;
}

const state: TrackerState = {
  initialized: false,
  sessionId: null,
  queue: [],
  flushTimer: null,
};

function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureSessionId(): string {
  if (!state.sessionId) state.sessionId = newSessionId();
  return state.sessionId;
}

/**
 * Initialize the tracker. Idempotent — safe to call from multiple components.
 * Wires up periodic flush, visibilitychange, pagehide listeners, plus global
 * uncaught-error capture so any throw the app fails to catch lands as an
 * `error_occurred` KPI event.
 */
export function initEventTracker(): void {
  if (typeof window === "undefined" || state.initialized) return;
  state.initialized = true;
  ensureSessionId();

  state.flushTimer = setInterval(() => {
    void flush(false);
  }, FLUSH_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush(true);
  });
  window.addEventListener("pagehide", () => void flush(true));

  window.addEventListener("error", (ev) => {
    trackError({
      source: "client/window",
      code: "UNCAUGHT",
      message: ev.message || String(ev.error ?? "unknown"),
      context: `${ev.filename ?? ""}:${ev.lineno ?? ""}`,
    });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    const msg =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : (() => {
              try {
                return JSON.stringify(reason);
              } catch {
                return String(reason);
              }
            })();
    trackError({
      source: "client/promise",
      code: "UNHANDLED_REJECTION",
      message: msg,
      context: window.location.pathname,
    });
  });

  trackEvent("session_start", { pagePath: window.location.pathname });
}

export function trackEvent(
  type: ClientEventType,
  payload?: EventPayload
): void {
  if (typeof window === "undefined") return;
  state.queue.push({
    type,
    payload: payload ?? {},
    sessionId: ensureSessionId(),
    clientTimestamp: new Date().toISOString(),
  });
  if (state.queue.length >= MAX_BUFFER) void flush(false);
}

async function flush(useBeacon: boolean): Promise<void> {
  if (state.queue.length === 0) return;
  const batch = state.queue;
  state.queue = [];
  const body = JSON.stringify({ events: batch });

  try {
    if (
      useBeacon &&
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      const blob = new Blob([body], { type: "application/json" });
      const sent = navigator.sendBeacon(ENDPOINT, blob);
      if (sent) return;
      // Fallthrough to fetch with keepalive if beacon refused.
    }
    await fetch(ENDPOINT, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      keepalive: useBeacon,
    });
  } catch {
    // Best-effort: drop on error.
  }
}

export interface ClientErrorInput {
  source: string;
  code?: string;
  message?: string;
  severity?: "warn" | "error" | "fatal";
  statusCode?: number;
  context?: string;
}

/**
 * Fire an `error_occurred` KPI event from the client. Best-effort: same
 * delivery semantics as trackEvent (batched flush via /api/events/track).
 */
export function trackError(input: ClientErrorInput): void {
  const payload: EventPayload = {
    source: String(input.source).slice(0, 200),
    code: String(input.code ?? "UNSPECIFIED").slice(0, 200),
    message: String(input.message ?? "").slice(0, 1000),
    severity: input.severity ?? "error",
  };
  if (typeof input.statusCode === "number") payload.statusCode = input.statusCode;
  if (input.context) payload.context = String(input.context).slice(0, 200);
  trackEvent("error_occurred", payload);
}

/**
 * Force-flush. Useful in tests or when an explicit flush is required (rare).
 */
export function flushEventsNow(): Promise<void> {
  return flush(false);
}
