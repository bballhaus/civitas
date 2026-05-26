// Bidding-tracker payload: every RFP in this user's pipeline, joined to the
// rfp_cache snapshot for title/agency/deadline, plus every task for those
// RFPs. One round-trip per /tracker page load.

import { NextResponse } from "next/server";
import { and, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { rfpCache } from "@/db/schema";
import { getAuthenticatedUser } from "@/lib/auth";
import { getTrackerEntries, type PipelineStatus } from "@/db/queries/match-state";
import { getAllTasksForUser, seedDefaultTasks } from "@/db/queries/rfp-tasks";
import { visibleRfpSourceClause } from "@/lib/rfp-source-visibility";

interface TrackerRfp {
  id: string;
  title: string;
  agency: string | null;
  deadline: string | null; // ISO
  estimatedValueUsd: number | null;
  sourceId: string | null;
  status: PipelineStatus;
  statusChangedAt: string | null;
  // LLM-extracted dates from attachment PDFs. Any field may be null when
  // the source document doesn't state that date.
  qaDeadline: string | null;
  qaResponseDate: string | null;
  prebidMeetingAt: string | null;
  siteVisitAt: string | null;
  awardDate: string | null;
  contractStart: string | null;
  contractEnd: string | null;
}

interface TrackerTask {
  id: string;
  rfpId: string;
  label: string;
  dueDate: string | null;
  completedAt: string | null;
  sortOrder: number;
  isCustom: boolean;
}

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const entries = await getTrackerEntries(user.userId);
  const rfpIds = entries.map((e) => e.rfpId);

  const [cacheRows, initialTaskRows] = await Promise.all([
    rfpIds.length === 0
      ? Promise.resolve([] as Array<{
          id: string;
          title: string;
          agency: string | null;
          deadline: Date | null;
          estimatedValueUsd: number | null;
          sourceId: string;
          qaDeadline: Date | null;
          qaResponseDate: string | null;
          prebidMeetingAt: Date | null;
          siteVisitAt: Date | null;
          awardDate: string | null;
          contractStart: string | null;
          contractEnd: string | null;
        }>)
      : db
          .select({
            id: rfpCache.id,
            title: rfpCache.title,
            agency: rfpCache.agency,
            deadline: rfpCache.deadline,
            estimatedValueUsd: rfpCache.estimatedValueUsd,
            sourceId: rfpCache.sourceId,
            qaDeadline: rfpCache.qaDeadline,
            qaResponseDate: rfpCache.qaResponseDate,
            prebidMeetingAt: rfpCache.prebidMeetingAt,
            siteVisitAt: rfpCache.siteVisitAt,
            awardDate: rfpCache.awardDate,
            contractStart: rfpCache.contractStart,
            contractEnd: rfpCache.contractEnd,
          })
          .from(rfpCache)
          .where(and(inArray(rfpCache.id, rfpIds), visibleRfpSourceClause())),
    getAllTasksForUser(user.userId),
  ]);

  // Self-heal: seed the default task template for any tracked RFP that
  // somehow ended up without tasks (e.g. saved before the template logic
  // shipped, or seeded called from a path that lost). seedDefaultTasks is
  // idempotent so this is safe even on a cold path.
  const rfpsWithTasks = new Set(initialTaskRows.map((t) => t.rfpId));
  const missingTaskRfps = rfpIds.filter((id) => !rfpsWithTasks.has(id));
  let taskRows = initialTaskRows;
  if (missingTaskRfps.length > 0) {
    await Promise.all(
      missingTaskRfps.map((rfpId) =>
        seedDefaultTasks(user.userId, rfpId).catch((err) => {
          console.warn(`[tracker] failed to seed default tasks for rfp ${rfpId}:`, err);
          return [];
        }),
      ),
    );
    taskRows = await getAllTasksForUser(user.userId);
  }

  const cacheById = new Map(cacheRows.map((r) => [r.id, r]));

  // Any tracked RFP missing from rfp_cache (e.g. closed since save) still
  // appears in the tracker — we just don't have title/deadline to show.
  const rfps: TrackerRfp[] = entries.map((e) => {
    const row = cacheById.get(e.rfpId);
    return {
      id: e.rfpId,
      title: row?.title ?? "(RFP no longer in catalog)",
      agency: row?.agency ?? null,
      deadline: row?.deadline ? row.deadline.toISOString() : null,
      estimatedValueUsd: row?.estimatedValueUsd ?? null,
      sourceId: row?.sourceId ?? null,
      status: e.status,
      statusChangedAt: e.statusChangedAt ? e.statusChangedAt.toISOString() : null,
      qaDeadline: row?.qaDeadline ? row.qaDeadline.toISOString() : null,
      qaResponseDate: row?.qaResponseDate ?? null,
      prebidMeetingAt: row?.prebidMeetingAt ? row.prebidMeetingAt.toISOString() : null,
      siteVisitAt: row?.siteVisitAt ? row.siteVisitAt.toISOString() : null,
      awardDate: row?.awardDate ?? null,
      contractStart: row?.contractStart ?? null,
      contractEnd: row?.contractEnd ?? null,
    };
  });

  const tasks: TrackerTask[] = taskRows.map((t) => ({
    id: t.id,
    rfpId: t.rfpId,
    label: t.label,
    dueDate: t.dueDate ?? null,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    sortOrder: t.sortOrder,
    isCustom: t.isCustom,
  }));

  return NextResponse.json(
    { rfps, tasks },
    { headers: { "Cache-Control": "no-store" } },
  );
}
