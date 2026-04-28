/**
 * Server-side KPI event recorder. Writes to two DynamoDB tables:
 *
 *   civitas-kpi-events  — raw event log (one item per event), TTL'd at 90 days
 *   civitas-kpi-users   — per-user aggregate (counters + funnel timestamps)
 *
 * All public functions are fire-and-forget: failures are logged but never
 * thrown. KPI logging must never break the user-facing flow.
 */
import {
  PutCommand,
  UpdateCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import {
  getDynamoClient,
  getKpiEventsTable,
  getKpiUsersTable,
} from "./dynamodb";
import {
  EVENT_COUNTER,
  EVENT_FUNNEL,
  type EventType,
  type EventPayload,
  type TrackedEvent,
} from "./events";
import { config } from "./config";

interface RecordOpts {
  sessionId?: string;
  /** ISO timestamp; defaults to now. */
  eventTimestamp?: string;
}

function userPk(username: string): string {
  return `USER#${encodeURIComponent(username)}`;
}

function eventSk(ts: string, eventId: string): string {
  return `EVENT#${ts}#${eventId}`;
}

function isoWeek(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7
  );
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function ttlFromNow(now: Date): number {
  return Math.floor(now.getTime() / 1000) + config.kpi.eventTtlDays * 86_400;
}

interface RawEventItem {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  username: string;
  type: EventType;
  payload: EventPayload;
  sessionId?: string;
  timestamp: string;
  ttl: number;
}

function buildEventItem(
  username: string,
  type: EventType,
  ts: string,
  payload: EventPayload,
  sessionId: string | undefined,
  ttl: number
): RawEventItem {
  const eventId = randomUUID();
  return {
    pk: userPk(username),
    sk: eventSk(ts, eventId),
    gsi1pk: `TYPE#${type}`,
    gsi1sk: `${ts}#${encodeURIComponent(username)}#${eventId}`,
    username,
    type,
    payload,
    sessionId,
    timestamp: ts,
    ttl,
  };
}

async function writeEventItem(item: RawEventItem): Promise<void> {
  await getDynamoClient().send(
    new PutCommand({
      TableName: getKpiEventsTable(),
      Item: item,
    })
  );
}

async function updateUserSummary(
  username: string,
  type: EventType,
  ts: string
): Promise<void> {
  const counterField = EVENT_COUNTER[type];
  const funnelField = EVENT_FUNNEL[type];

  const setParts: string[] = ["last_active_at = :ts", "#u = if_not_exists(#u, :username)"];
  const addParts: string[] = [];
  const exprAttrNames: Record<string, string> = { "#u": "username" };
  const exprAttrValues: Record<string, unknown> = {
    ":ts": ts,
    ":username": username,
  };

  if (funnelField) {
    const alias = `#${funnelField}`;
    setParts.push(`${alias} = if_not_exists(${alias}, :ts)`);
    exprAttrNames[alias] = funnelField;
  }

  if (type === "signup") {
    const cohort = isoWeek(new Date(ts));
    setParts.push("signup_at = if_not_exists(signup_at, :ts)");
    setParts.push("cohort_week = if_not_exists(cohort_week, :cohort)");
    setParts.push("gsi1pk = if_not_exists(gsi1pk, :cohortPk)");
    setParts.push("gsi1sk = if_not_exists(gsi1sk, :username)");
    exprAttrValues[":cohort"] = cohort;
    exprAttrValues[":cohortPk"] = `COHORT#${cohort}`;
  }

  if (counterField) {
    const alias = `#${counterField}`;
    addParts.push(`${alias} :one`);
    exprAttrNames[alias] = counterField;
    exprAttrValues[":one"] = 1;
  }

  let updateExpr = "SET " + setParts.join(", ");
  if (addParts.length) updateExpr += " ADD " + addParts.join(", ");

  await getDynamoClient().send(
    new UpdateCommand({
      TableName: getKpiUsersTable(),
      Key: { pk: userPk(username) },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprAttrNames,
      ExpressionAttributeValues: exprAttrValues,
    })
  );
}

/**
 * Record a single event. Never throws — failures are logged.
 */
export async function recordEvent(
  username: string,
  type: EventType,
  payload: EventPayload = {},
  opts: RecordOpts = {}
): Promise<void> {
  if (!username) return;
  const now = new Date();
  const ts = opts.eventTimestamp ?? now.toISOString();
  const item = buildEventItem(
    username,
    type,
    ts,
    payload,
    opts.sessionId,
    ttlFromNow(now)
  );
  const results = await Promise.allSettled([
    writeEventItem(item),
    updateUserSummary(username, type, ts),
  ]);
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn(
        `KPI recordEvent partial failure (${username}/${type}):`,
        r.reason
      );
    }
  }
}

/**
 * Record a batch of events for a single user. Used by /api/events/track
 * for client-batched events sent via sendBeacon.
 */
export async function recordEvents(
  username: string,
  events: TrackedEvent[]
): Promise<void> {
  if (!username || events.length === 0) return;
  const now = new Date();
  const ttl = ttlFromNow(now);

  // Build raw event items
  const items: RawEventItem[] = events.map((ev) => {
    const ts = ev.clientTimestamp || now.toISOString();
    return buildEventItem(username, ev.type, ts, ev.payload ?? {}, ev.sessionId, ttl);
  });

  // BatchWrite supports max 25 items per request
  const chunks: RawEventItem[][] = [];
  for (let i = 0; i < items.length; i += 25) {
    chunks.push(items.slice(i, i + 25));
  }

  const eventWrites = chunks.map((chunk) =>
    getDynamoClient().send(
      new BatchWriteCommand({
        RequestItems: {
          [getKpiEventsTable()]: chunk.map((Item) => ({ PutRequest: { Item } })),
        },
      })
    )
  );

  // Fan out summary updates in parallel
  const summaryUpdates = items.map((item) =>
    updateUserSummary(username, item.type, item.timestamp)
  );

  const results = await Promise.allSettled([...eventWrites, ...summaryUpdates]);
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn(`KPI recordEvents partial failure (${username}):`, r.reason);
    }
  }
}
