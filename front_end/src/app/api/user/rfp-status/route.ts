// Bidding-tracker pipeline + match feedback + generated-doc storage.
//
// Pipeline transitions (saved / in_progress / bid_submitted / won / lost /
// no_bid) and match feedback live in Postgres (match_state). Generated POE /
// proposal content stays in the S3 user-data JSON for now.
//
// First entry into the tracker ('saved' from a null state) auto-seeds the
// 7-item default task template via seedDefaultTasks.

import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  getPipelineSnapshot,
  setRfpStatus,
  setMatchFeedback,
  removeMatchFeedback,
  isPipelineStatus,
  type PipelineStatus,
} from "@/db/queries/match-state";
import { seedDefaultTasks } from "@/db/queries/rfp-tasks";
import { saveGeneratedPoe, saveGeneratedProposal } from "@/lib/rfp-status";
import { recordEvent } from "@/lib/event-log";
import type { ServerEventType } from "@/lib/events";

const RFP_ID_PATTERN = /^[\w\-.:]{1,200}$/;
function isValidRfpId(id: string): boolean {
  return RFP_ID_PATTERN.test(id);
}

function statusEventType(status: PipelineStatus | null, prev: PipelineStatus | null): ServerEventType {
  if (status === null) return "rfp_status_cleared";
  switch (status) {
    case "saved":
      return "rfp_saved";
    case "in_progress":
      return "rfp_in_progress";
    case "bid_submitted":
      return "rfp_applied"; // historical event name kept; semantically "bid submitted"
    case "won":
      return "rfp_won";
    case "lost":
      return "rfp_lost";
    case "no_bid":
      return "rfp_no_bid";
    default:
      return prev === "saved" ? "rfp_unsaved" : "rfp_status_cleared";
  }
}

export async function PATCH(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const data = await request.json();
    const {
      set_status,
      submit_match_feedback,
      remove_match_feedback,
      save_generated_poe,
      save_generated_proposal,
    } = data;

    if (
      !set_status &&
      !submit_match_feedback &&
      !remove_match_feedback &&
      !save_generated_poe &&
      !save_generated_proposal
    ) {
      return NextResponse.json(
        {
          error:
            "Provide set_status, submit_match_feedback, remove_match_feedback, save_generated_poe, or save_generated_proposal.",
        },
        { status: 400 }
      );
    }

    // set_status: { rfp_id: string, status: PipelineStatus | null }
    if (set_status && typeof set_status === "object") {
      const id = String(set_status.rfp_id ?? "").trim();
      if (!id || !isValidRfpId(id)) {
        return NextResponse.json({ error: "Invalid RFP ID format" }, { status: 400 });
      }
      const status = set_status.status;
      if (status !== null && !isPipelineStatus(status)) {
        return NextResponse.json({ error: "Invalid status value" }, { status: 400 });
      }
      await setRfpStatus(user.userId, id, status as PipelineStatus | null);
      // Seed the 7-task default template on every non-null status set.
      // seedDefaultTasks() is idempotent (no-op if the RFP already has any
      // tasks), so this safely covers users who entered the tracker via a
      // path other than fresh-insert (e.g., RFPs that were already in
      // match_state from feedback or pre-migration 'applied' rows).
      if (status !== null) {
        try {
          await seedDefaultTasks(user.userId, id);
        } catch (err) {
          console.warn("Failed to seed default tasks", err);
        }
      }
      void recordEvent(user.username, statusEventType(status as PipelineStatus | null, null), { rfpId: id });
    }

    if (submit_match_feedback && typeof submit_match_feedback === "object") {
      const { rfp_id, rating, reason, match_score, match_tier } = submit_match_feedback;
      if (
        rfp_id &&
        (rating === "good" || rating === "bad") &&
        typeof match_score === "number" &&
        typeof match_tier === "string"
      ) {
        const id = String(rfp_id).trim();
        if (!isValidRfpId(id)) {
          return NextResponse.json({ error: "Invalid RFP ID format" }, { status: 400 });
        }
        await setMatchFeedback(user.userId, id, {
          rating,
          reason: typeof reason === "string" ? reason : undefined,
          match_score,
          match_tier,
          created_at: new Date().toISOString(),
        });
        void recordEvent(user.username, "match_feedback_submitted", {
          rfpId: id,
          rating,
          matchScore: match_score,
          matchTier: match_tier,
        });
      }
    }

    if (remove_match_feedback) {
      const id = String(remove_match_feedback).trim();
      if (id && isValidRfpId(id)) {
        await removeMatchFeedback(user.userId, id);
        void recordEvent(user.username, "match_feedback_removed", { rfpId: id });
      }
    }

    if (save_generated_poe && typeof save_generated_poe === "object") {
      const rfpId = save_generated_poe.rfp_id;
      const content = save_generated_poe.content;
      if (rfpId && typeof content === "string") {
        const id = String(rfpId).trim();
        if (!isValidRfpId(id)) {
          return NextResponse.json({ error: "Invalid RFP ID format" }, { status: 400 });
        }
        await saveGeneratedPoe(user.username, id, content);
      }
    }
    if (save_generated_proposal && typeof save_generated_proposal === "object") {
      const rfpId = save_generated_proposal.rfp_id;
      const content = save_generated_proposal.content;
      if (rfpId && typeof content === "string") {
        const id = String(rfpId).trim();
        if (!isValidRfpId(id)) {
          return NextResponse.json({ error: "Invalid RFP ID format" }, { status: 400 });
        }
        await saveGeneratedProposal(user.username, id, content);
      }
    }

    const snapshot = await getPipelineSnapshot(user.userId);
    return NextResponse.json(snapshot);
  } catch (err) {
    console.error("RFP status update error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
