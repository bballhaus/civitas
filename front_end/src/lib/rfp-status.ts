/**
 * Generated-document storage (POE, proposals) keyed by (username, rfp_id),
 * persisted in the S3 user-data JSON blob.
 *
 * Pipeline status (saved/in_progress/bid_submitted/won/lost/no_bid) and
 * match feedback now live in Postgres — see `src/db/queries/match-state.ts`.
 */
import { getUserData, saveUserData, type UserData } from "./user-data";

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
