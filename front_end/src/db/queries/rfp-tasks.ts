// RFP task data-access layer.
//
// Per-(user, RFP) checklist for the bidding tracker. When an RFP first
// enters the tracker (status flipped to 'saved'), seed the default 7-item
// template so the user has structure out of the box.

import { and, asc, eq } from "drizzle-orm";
import { db } from "../client";
import { rfpCache, rfpTasks, type RfpTask } from "../schema";

/**
 * Default checklist seeded once when an RFP first enters the tracker.
 *
 * `dateSource` controls auto-population of `dueDate` from the rfp_cache row.
 * One row per extracted date column on rfp_cache, plus three undated steps
 * (review, draft, internal review) for human workflow.
 *
 * Tasks without a `dateSource` are seeded with `due_date = NULL` so the user
 * can fill it in manually. We keep labels stable so existing tracker UIs
 * (and the backfill script) match by label.
 */
type TaskDateSource =
  | "deadline"
  | "qa_deadline"
  | "qa_response"
  | "prebid"
  | "site_visit"
  | "award"
  | "contract_start"
  | "contract_end";

export const DEFAULT_TASK_TEMPLATE: ReadonlyArray<{
  label: string;
  dateSource?: TaskDateSource;
}> = [
  { label: "Review RFP and attachments" },
  { label: "Confirm bid / no-bid decision" },
  { label: "Submit questions by Q&A deadline", dateSource: "qa_deadline" },
  { label: "Q&A answers posted", dateSource: "qa_response" },
  { label: "Attend pre-bid meeting", dateSource: "prebid" },
  { label: "Site visit", dateSource: "site_visit" },
  { label: "Draft proposal" },
  { label: "Internal review" },
  { label: "Submit bid by deadline", dateSource: "deadline" },
  { label: "Award decision", dateSource: "award" },
  { label: "Contract starts", dateSource: "contract_start" },
  { label: "Contract ends", dateSource: "contract_end" },
] as const;

// Convert a Date or date-string to the YYYY-MM-DD shape the `due_date`
// column expects. Drops the time component intentionally — tracker tasks
// are day-granularity.
function toDateOnly(d: Date | string | null): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

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
 *
 * Looks up the RFP's deadline + extracted key dates (qa_deadline,
 * prebid_meeting_at, site_visit_at) from rfp_cache to auto-populate the
 * matching seeded task `dueDate`s. Tasks whose source date is null (or
 * whose RFP isn't in rfp_cache) seed with `due_date = NULL`.
 */
export async function seedDefaultTasks(userId: string, rfpId: string): Promise<RfpTask[]> {
  const existing = await db
    .select({ id: rfpTasks.id })
    .from(rfpTasks)
    .where(and(eq(rfpTasks.userId, userId), eq(rfpTasks.rfpId, rfpId)))
    .limit(1);
  if (existing.length > 0) return [];

  const [cacheRow] = await db
    .select({
      deadline: rfpCache.deadline,
      qaDeadline: rfpCache.qaDeadline,
      qaResponseDate: rfpCache.qaResponseDate,
      prebidMeetingAt: rfpCache.prebidMeetingAt,
      siteVisitAt: rfpCache.siteVisitAt,
      awardDate: rfpCache.awardDate,
      contractStart: rfpCache.contractStart,
      contractEnd: rfpCache.contractEnd,
    })
    .from(rfpCache)
    .where(eq(rfpCache.id, rfpId))
    .limit(1);

  const dueDateFor = (src: TaskDateSource | undefined): string | null => {
    if (!src || !cacheRow) return null;
    switch (src) {
      case "deadline": return toDateOnly(cacheRow.deadline);
      case "qa_deadline": return toDateOnly(cacheRow.qaDeadline);
      case "qa_response": return toDateOnly(cacheRow.qaResponseDate);
      case "prebid": return toDateOnly(cacheRow.prebidMeetingAt);
      case "site_visit": return toDateOnly(cacheRow.siteVisitAt);
      case "award": return toDateOnly(cacheRow.awardDate);
      case "contract_start": return toDateOnly(cacheRow.contractStart);
      case "contract_end": return toDateOnly(cacheRow.contractEnd);
      default: return null;
    }
  };

  const rows = await db
    .insert(rfpTasks)
    .values(
      DEFAULT_TASK_TEMPLATE.map((t, i) => ({
        userId,
        rfpId,
        label: t.label,
        dueDate: dueDateFor(t.dateSource),
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
