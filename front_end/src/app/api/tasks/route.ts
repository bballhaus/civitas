// Per-(user, RFP) task collection. Companion to the bidding tracker.
//
// GET  /api/tasks?rfp_id=<id>   → list tasks for one RFP
// GET  /api/tasks               → list every task for the current user
// POST /api/tasks               → { rfp_id, label, due_date? } create a task
//
// Mutations on a single task (toggle complete, rename, set due date, delete)
// live at /api/tasks/[id].

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  createTask,
  getAllTasksForUser,
  getTasksForRfp,
} from "@/db/queries/rfp-tasks";

const RFP_ID_PATTERN = /^[\w\-.:]{1,200}$/;
const MAX_LABEL_LEN = 200;

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const rfpId = searchParams.get("rfp_id");
  if (rfpId) {
    if (!RFP_ID_PATTERN.test(rfpId)) {
      return NextResponse.json({ error: "Invalid RFP ID format" }, { status: 400 });
    }
    const tasks = await getTasksForRfp(user.userId, rfpId);
    return NextResponse.json({ tasks });
  }
  const tasks = await getAllTasksForUser(user.userId);
  return NextResponse.json({ tasks });
}

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const data = body as { rfp_id?: unknown; label?: unknown; due_date?: unknown };
  const rfpId = String(data.rfp_id ?? "").trim();
  const label = String(data.label ?? "").trim();
  if (!rfpId || !RFP_ID_PATTERN.test(rfpId)) {
    return NextResponse.json({ error: "Invalid RFP ID format" }, { status: 400 });
  }
  if (!label || label.length > MAX_LABEL_LEN) {
    return NextResponse.json({ error: "Label must be 1-200 chars" }, { status: 400 });
  }
  const dueDate =
    typeof data.due_date === "string" && data.due_date.trim() ? data.due_date.trim() : null;
  const task = await createTask({ userId: user.userId, rfpId, label, dueDate });
  return NextResponse.json({ task }, { status: 201 });
}
