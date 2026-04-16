/**
 * User RFP status tracking: applied, in-progress, generated docs.
 * Port of back_end/contracts/services/user_rfp_status.py.
 */
import { getUserData, saveUserData, type UserData, type MatchFeedback } from "./user-data";

function ensureList(val: unknown): string[] {
  return Array.isArray(val) ? val : [];
}

export interface RfpStatus {
  applied_rfp_ids: string[];
  in_progress_rfp_ids: string[];
  match_feedback_by_rfp: Record<string, MatchFeedback>;
}

function ensureFeedbackMap(val: unknown): Record<string, MatchFeedback> {
  return val && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, MatchFeedback>)
    : {};
}

export async function getRfpStatus(username: string): Promise<RfpStatus> {
  const data = await getUserData(username);
  if (!data) return { applied_rfp_ids: [], in_progress_rfp_ids: [], match_feedback_by_rfp: {} };
  return {
    applied_rfp_ids: ensureList(data.applied_rfp_ids),
    in_progress_rfp_ids: ensureList(data.in_progress_rfp_ids),
    match_feedback_by_rfp: ensureFeedbackMap(data.match_feedback_by_rfp),
  };
}

export async function addAppliedRfp(
  username: string,
  rfpId: string
): Promise<RfpStatus> {
  const data = (await getUserData(username)) || ({} as UserData);
  const applied = ensureList(data.applied_rfp_ids);
  const id = rfpId.trim();
  if (id && !applied.includes(id)) {
    applied.push(id);
    data.applied_rfp_ids = applied;
    await saveUserData(username, data);
  }
  return {
    applied_rfp_ids: applied,
    in_progress_rfp_ids: ensureList(data.in_progress_rfp_ids),
    match_feedback_by_rfp: ensureFeedbackMap(data.match_feedback_by_rfp),
  };
}

export async function removeAppliedRfp(
  username: string,
  rfpId: string
): Promise<RfpStatus> {
  const data = (await getUserData(username)) || ({} as UserData);
  const applied = ensureList(data.applied_rfp_ids);
  const id = rfpId.trim();
  if (id && applied.includes(id)) {
    data.applied_rfp_ids = applied.filter((x) => x !== id);
    await saveUserData(username, data);
  }
  return {
    applied_rfp_ids: ensureList(data.applied_rfp_ids),
    in_progress_rfp_ids: ensureList(data.in_progress_rfp_ids),
    match_feedback_by_rfp: ensureFeedbackMap(data.match_feedback_by_rfp),
  };
}

export async function addInProgressRfp(
  username: string,
  rfpId: string
): Promise<RfpStatus> {
  const data = (await getUserData(username)) || ({} as UserData);
  const inProgress = ensureList(data.in_progress_rfp_ids);
  const id = rfpId.trim();
  if (id && !inProgress.includes(id)) {
    inProgress.push(id);
    data.in_progress_rfp_ids = inProgress;
    await saveUserData(username, data);
  }
  return {
    applied_rfp_ids: ensureList(data.applied_rfp_ids),
    in_progress_rfp_ids: inProgress,
    match_feedback_by_rfp: ensureFeedbackMap(data.match_feedback_by_rfp),
  };
}

export async function removeInProgressRfp(
  username: string,
  rfpId: string
): Promise<RfpStatus> {
  const data = (await getUserData(username)) || ({} as UserData);
  const inProgress = ensureList(data.in_progress_rfp_ids);
  const id = rfpId.trim();
  if (id && inProgress.includes(id)) {
    data.in_progress_rfp_ids = inProgress.filter((x) => x !== id);
    await saveUserData(username, data);
  }
  return {
    applied_rfp_ids: ensureList(data.applied_rfp_ids),
    in_progress_rfp_ids: ensureList(data.in_progress_rfp_ids),
    match_feedback_by_rfp: ensureFeedbackMap(data.match_feedback_by_rfp),
  };
}

export async function getGeneratedPoe(
  username: string,
  rfpId: string
): Promise<string | null> {
  const data = await getUserData(username);
  if (!data) return null;
  const byRfp = data.generated_poe_by_rfp;
  if (!byRfp || typeof byRfp !== "object") return null;
  const content = byRfp[rfpId.trim()];
  return typeof content === "string" ? content : null;
}

export async function saveGeneratedPoe(
  username: string,
  rfpId: string,
  content: string
): Promise<void> {
  const id = rfpId.trim();
  if (!id) return;
  const data = (await getUserData(username)) || ({} as UserData);
  if (!data.generated_poe_by_rfp || typeof data.generated_poe_by_rfp !== "object") {
    data.generated_poe_by_rfp = {};
  }
  data.generated_poe_by_rfp[id] = content;
  await saveUserData(username, data);
}

export async function getGeneratedProposal(
  username: string,
  rfpId: string
): Promise<string | null> {
  const data = await getUserData(username);
  if (!data) return null;
  const byRfp = data.generated_proposal_by_rfp;
  if (!byRfp || typeof byRfp !== "object") return null;
  const content = byRfp[rfpId.trim()];
  return typeof content === "string" ? content : null;
}

export async function saveGeneratedProposal(
  username: string,
  rfpId: string,
  content: string
): Promise<void> {
  const id = rfpId.trim();
  if (!id) return;
  const data = (await getUserData(username)) || ({} as UserData);
  if (!data.generated_proposal_by_rfp || typeof data.generated_proposal_by_rfp !== "object") {
    data.generated_proposal_by_rfp = {};
  }
  data.generated_proposal_by_rfp[id] = content;
  await saveUserData(username, data);
}

export async function getMatchFeedback(
  username: string
): Promise<Record<string, MatchFeedback>> {
  const data = await getUserData(username);
  if (!data) return {};
  return ensureFeedbackMap(data.match_feedback_by_rfp);
}

export async function saveMatchFeedback(
  username: string,
  rfpId: string,
  feedback: MatchFeedback
): Promise<RfpStatus> {
  const id = rfpId.trim();
  if (!id) {
    return getRfpStatus(username);
  }
  const data = (await getUserData(username)) || ({} as UserData);
  if (!data.match_feedback_by_rfp || typeof data.match_feedback_by_rfp !== "object") {
    data.match_feedback_by_rfp = {};
  }
  data.match_feedback_by_rfp[id] = feedback;
  await saveUserData(username, data);
  return {
    applied_rfp_ids: ensureList(data.applied_rfp_ids),
    in_progress_rfp_ids: ensureList(data.in_progress_rfp_ids),
    match_feedback_by_rfp: ensureFeedbackMap(data.match_feedback_by_rfp),
  };
}

export async function removeMatchFeedback(
  username: string,
  rfpId: string
): Promise<RfpStatus> {
  const id = rfpId.trim();
  if (!id) {
    return getRfpStatus(username);
  }
  const data = (await getUserData(username)) || ({} as UserData);
  const feedbackMap = ensureFeedbackMap(data.match_feedback_by_rfp);
  if (id in feedbackMap) {
    delete feedbackMap[id];
    data.match_feedback_by_rfp = feedbackMap;
    await saveUserData(username, data);
  }
  return {
    applied_rfp_ids: ensureList(data.applied_rfp_ids),
    in_progress_rfp_ids: ensureList(data.in_progress_rfp_ids),
    match_feedback_by_rfp: ensureFeedbackMap(data.match_feedback_by_rfp),
  };
}
