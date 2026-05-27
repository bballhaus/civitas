/**
 * Admin event drill-down. Queries the byEventType GSI on civitas-kpi-events
 * and returns the most recent N events of a single type. Powers the
 * "recent events" table on /admin/kpis.
 *
 *   GET /api/admin/events?type=filter_applied&limit=50
 *
 * Same admin gate as /admin/kpis — see lib/admin-auth.ts.
 */
import { NextResponse } from "next/server";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { requireAdmin } from "@/lib/admin-auth";
import { getDynamoClient, getKpiEventsTable } from "@/lib/dynamodb";
import { isEventType } from "@/lib/events";

export const runtime = "nodejs";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export async function GET(request: Request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, limitRaw ? Number(limitRaw) || DEFAULT_LIMIT : DEFAULT_LIMIT),
  );

  if (!type || !isEventType(type)) {
    return NextResponse.json(
      { error: "Missing or invalid `type` query parameter" },
      { status: 400 },
    );
  }

  try {
    const resp = await getDynamoClient().send(
      new QueryCommand({
        TableName: getKpiEventsTable(),
        IndexName: "byEventType",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `TYPE#${type}` },
        ScanIndexForward: false, // newest first
        Limit: limit,
      }),
    );

    const events = (resp.Items ?? []).map((item) => ({
      type: item.type,
      timestamp: item.timestamp,
      username: item.username,
      sessionId: item.sessionId,
      payload: item.payload,
    }));

    return NextResponse.json({ type, count: events.length, events });
  } catch (err) {
    console.error("[admin/events] query failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Query failed" },
      { status: 500 },
    );
  }
}
