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

    if (remove_applied) {
      const id = String(remove_applied).trim();
      if (id) result = await removeAppliedRfp(username, id);
    }
    if (mark_applied) {
      const id = String(mark_applied).trim();
      if (id) result = await addAppliedRfp(username, id);
    }
    if (remove_in_progress) {
      const id = String(remove_in_progress).trim();
      if (id) result = await removeInProgressRfp(username, id);
    }
    if (mark_in_progress) {
      const id = String(mark_in_progress).trim();
      if (id) result = await addInProgressRfp(username, id);
    }
    if (save_generated_poe && typeof save_generated_poe === "object") {
      const rfpId = save_generated_poe.rfp_id;
      const content = save_generated_poe.content;
      if (rfpId && typeof content === "string") {
        await saveGeneratedPoe(username, String(rfpId).trim(), content);
      }
    }
    if (save_generated_proposal && typeof save_generated_proposal === "object") {
      const rfpId = save_generated_proposal.rfp_id;
      const content = save_generated_proposal.content;
      if (rfpId && typeof content === "string") {
        await saveGeneratedProposal(username, String(rfpId).trim(), content);
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
