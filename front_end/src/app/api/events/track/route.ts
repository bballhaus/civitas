/**
 * Client-side KPI event ingest. Accepts a batch of events from the browser
 * (typically sent via navigator.sendBeacon) and writes them to the DynamoDB
 * KPI tables.
 *
 * Only client-allowlisted event types are accepted here — server events fire
 * directly from API routes and never come through this endpoint.
 */
import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { recordEvents } from "@/lib/event-log";
import {
  isClientEventType,
  type TrackedEvent,
  type EventType,
} from "@/lib/events";
import { config } from "@/lib/config";

const RATE = config.kpi.rateLimit;
const MAX_BATCH = config.kpi.maxBatchSize;
const MAX_PAYLOAD_KEYS = 20;
const MAX_STRING_LEN = 200;
const MAX_BODY_BYTES = 64 * 1024; // 64KB

function sanitizePayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_PAYLOAD_KEYS) break;
    if (typeof k !== "string" || k.length > 64) continue;
    if (typeof v === "string") {
      out[k] = v.slice(0, MAX_STRING_LEN);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v;
    } // drop anything else (objects, nulls, undefineds) — keeps payloads flat
    n++;
  }
  return out;
}

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const ip = getClientIp(request);
  const rl = checkRateLimit(`kpi:${user.username}:${ip}`, RATE.limit, RATE.windowMs);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) } }
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !Array.isArray((body as { events?: unknown }).events)) {
    return NextResponse.json({ error: "Expected { events: [...] }" }, { status: 400 });
  }

  const rawEvents = (body as { events: unknown[] }).events;
  if (rawEvents.length === 0) {
    return NextResponse.json({ accepted: 0 });
  }
  if (rawEvents.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `Batch exceeds max size of ${MAX_BATCH}` },
      { status: 400 }
    );
  }

  const validated: TrackedEvent[] = [];
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.type !== "string" || !isClientEventType(r.type)) continue;
    validated.push({
      type: r.type as EventType,
      payload: sanitizePayload(r.payload),
      sessionId:
        typeof r.sessionId === "string" && r.sessionId.length <= 64
          ? r.sessionId
          : undefined,
      clientTimestamp:
        typeof r.clientTimestamp === "string" && r.clientTimestamp.length <= 32
          ? r.clientTimestamp
          : undefined,
    });
  }

  if (validated.length === 0) {
    return NextResponse.json({ accepted: 0 });
  }

  // Fire-and-forget: don't block the client on DDB writes
  void recordEvents(user.username, validated);

  return NextResponse.json({ accepted: validated.length });
}
