// Mutations on a single task.
//
// PATCH  /api/tasks/:id   → { label?, due_date?, completed? }
// DELETE /api/tasks/:id

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { deleteTask, updateTask } from "@/db/queries/rfp-tasks";

const MAX_LABEL_LEN = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const data = body as { label?: unknown; due_date?: unknown; completed?: unknown };
  const patch: { label?: string; dueDate?: string | null; completed?: boolean } = {};
  if (typeof data.label === "string") {
    const trimmed = data.label.trim();
    if (!trimmed || trimmed.length > MAX_LABEL_LEN) {
      return NextResponse.json({ error: "Label must be 1-200 chars" }, { status: 400 });
    }
    patch.label = trimmed;
  }
  if (data.due_date !== undefined) {
    if (data.due_date === null || data.due_date === "") {
      patch.dueDate = null;
    } else if (typeof data.due_date === "string") {
      patch.dueDate = data.due_date.trim();
    } else {
      return NextResponse.json({ error: "due_date must be string or null" }, { status: 400 });
    }
  }
  if (typeof data.completed === "boolean") {
    patch.completed = data.completed;
  }
  const task = await updateTask(user.userId, id, patch);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  return NextResponse.json({ task });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  const ok = await deleteTask(user.userId, id);
  if (!ok) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
