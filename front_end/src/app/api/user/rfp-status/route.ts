import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  getRfpStatus,
  addAppliedRfp,
  removeAppliedRfp,
  addInProgressRfp,
  removeInProgressRfp,
  saveGeneratedPoe,
  saveGeneratedProposal,
  saveMatchFeedback,
  removeMatchFeedback,
} from "@/lib/rfp-status";

// Validate RFP ID format: alphanumeric, dashes, dots, colons, underscores; max 200 chars
const RFP_ID_PATTERN = /^[\w\-.:]{1,200}$/;
function isValidRfpId(id: string): boolean {
  return RFP_ID_PATTERN.test(id);
}

export async function PATCH(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const data = await request.json();
    const {
      mark_applied,
      remove_applied,
      mark_in_progress,
      remove_in_progress,
      save_generated_poe,
      save_generated_proposal,
      submit_match_feedback,
      remove_match_feedback,
    } = data;

    if (
      !mark_applied &&
      !remove_applied &&
      !mark_in_progress &&
      !remove_in_progress &&
      !save_generated_poe &&
      !save_generated_proposal &&
      !submit_match_feedback &&
      !remove_match_feedback
    ) {
      return NextResponse.json(
        {
          error:
            "Provide mark_applied, remove_applied, mark_in_progress, remove_in_progress, save_generated_poe, save_generated_proposal, submit_match_feedback, and/or remove_match_feedback.",
        },
        { status: 400 }
      );
    }

    const username = user.username;
    let result = await getRfpStatus(username);

    // Validate and process each RFP ID field
    for (const [field, action] of [
      [remove_applied, removeAppliedRfp],
      [mark_applied, addAppliedRfp],
      [remove_in_progress, removeInProgressRfp],
      [mark_in_progress, addInProgressRfp],
    ] as const) {
      if (field) {
        const id = String(field).trim();
        if (id) {
          if (!isValidRfpId(id)) {
            return NextResponse.json({ error: "Invalid RFP ID format" }, { status: 400 });
          }
          result = await (action as (u: string, id: string) => Promise<typeof result>)(username, id);
        }
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
        await saveGeneratedPoe(username, id, content);
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
        await saveGeneratedProposal(username, id, content);
      }
    }
    if (submit_match_feedback && typeof submit_match_feedback === "object") {
      const { rfp_id, rating, reason, match_score, match_tier } = submit_match_feedback;
      if (rfp_id && (rating === "good" || rating === "bad") && typeof match_score === "number" && typeof match_tier === "string") {
        result = await saveMatchFeedback(username, String(rfp_id).trim(), {
          rating,
          reason: typeof reason === "string" ? reason : undefined,
          match_score,
          match_tier,
          created_at: new Date().toISOString(),
        });
      }
    }
    if (remove_match_feedback) {
      const id = String(remove_match_feedback).trim();
      if (id) result = await removeMatchFeedback(username, id);
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("RFP status update error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
