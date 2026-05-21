// RFP task data-access layer.
//
// Per-(user, RFP) checklist for the bidding tracker. When an RFP first
// enters the tracker (status flipped to 'saved'), seed the default 7-item
// template so the user has structure out of the box.

import { and, asc, eq } from "drizzle-orm";
import { db } from "../client";
import { rfpTasks, type RfpTask } from "../schema";

/** Default 7-item checklist seeded once when an RFP first enters the tracker. */
export const DEFAULT_TASK_TEMPLATE: ReadonlyArray<{ label: string }> = [
  { label: "Review RFP and attachments" },
  { label: "Confirm bid / no-bid decision" },
  { label: "Submit questions by Q&A deadline" },
  { label: "Attend pre-bid meeting" },
  { label: "Draft proposal" },
  { label: "Internal review" },
  { label: "Submit bid by deadline" },
] as const;

export async function getTasksForRfp(userId: string, rfpId: string): Promise<RfpTask[]> {
  return db
    .select()
    .from(rfpTasks)
    .where(and(eq(rfpTasks.userId, userId), eq(rfpTasks.rfpId, rfpId)))
    .orderBy(asc(rfpTasks.sortOrder), asc(rfpTasks.createdAt));
}

export async function getAllTasksForUser(userId: string): Promise<RfpTask[]> {
  return db
    .select()
    .from(rfpTasks)
    .where(eq(rfpTasks.userId, userId))
    .orderBy(asc(rfpTasks.rfpId), asc(rfpTasks.sortOrder));
}

/**
 * Idempotent: only seeds if no rows exist for this (user, RFP).
 * Returns the seeded rows, or [] if a template already existed.
 */
export async function seedDefaultTasks(userId: string, rfpId: string): Promise<RfpTask[]> {
  const existing = await db
    .select({ id: rfpTasks.id })
    .from(rfpTasks)
    .where(and(eq(rfpTasks.userId, userId), eq(rfpTasks.rfpId, rfpId)))
    .limit(1);
  if (existing.length > 0) return [];
  const rows = await db
    .insert(rfpTasks)
    .values(
      DEFAULT_TASK_TEMPLATE.map((t, i) => ({
        userId,
        rfpId,
        label: t.label,
        sortOrder: i,
        isCustom: false,
      })),
    )
    .returning();
  return rows;
}

export interface CreateTaskInput {
  userId: string;
  rfpId: string;
  label: string;
  dueDate?: string | null;
}

export async function createTask(input: CreateTaskInput): Promise<RfpTask> {
  // Place new tasks at the end (highest sort_order + 1).
  const trailing = await db
    .select({ sortOrder: rfpTasks.sortOrder })
    .from(rfpTasks)
    .where(and(eq(rfpTasks.userId, input.userId), eq(rfpTasks.rfpId, input.rfpId)))
    .orderBy(asc(rfpTasks.sortOrder));
  const nextOrder = trailing.length === 0 ? 0 : Math.max(...trailing.map((r) => r.sortOrder)) + 1;
  const [row] = await db
    .insert(rfpTasks)
    .values({
      userId: input.userId,
      rfpId: input.rfpId,
      label: input.label,
      dueDate: input.dueDate ?? null,
      sortOrder: nextOrder,
      isCustom: true,
    })
    .returning();
  return row;
}

export interface UpdateTaskInput {
  label?: string;
  dueDate?: string | null;
  completed?: boolean;
}

export async function updateTask(
  userId: string,
  taskId: string,
  patch: UpdateTaskInput,
): Promise<RfpTask | null> {
  const set: Partial<RfpTask> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.dueDate !== undefined) set.dueDate = patch.dueDate;
  if (patch.completed !== undefined) {
    set.completedAt = patch.completed ? new Date() : null;
  }
  if (Object.keys(set).length === 0) {
    const [row] = await db
      .select()
      .from(rfpTasks)
      .where(and(eq(rfpTasks.id, taskId), eq(rfpTasks.userId, userId)))
      .limit(1);
    return row ?? null;
  }
  const [row] = await db
    .update(rfpTasks)
    .set(set)
    .where(and(eq(rfpTasks.id, taskId), eq(rfpTasks.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteTask(userId: string, taskId: string): Promise<boolean> {
  const result = await db
    .delete(rfpTasks)
    .where(and(eq(rfpTasks.id, taskId), eq(rfpTasks.userId, userId)))
    .returning({ id: rfpTasks.id });
  return result.length > 0;
}

export async function deleteAllTasksForRfp(userId: string, rfpId: string): Promise<number> {
  const result = await db
    .delete(rfpTasks)
    .where(and(eq(rfpTasks.userId, userId), eq(rfpTasks.rfpId, rfpId)))
    .returning({ id: rfpTasks.id });
  return result.length;
}
