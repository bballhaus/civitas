import { NextResponse } from "next/server";
import { chatCompletion } from "@/lib/llm";

const PROMPT = `You are an expert government contracting consultant. Given an RFP and a company profile, produce a concise capabilities analysis that compares the user's qualifications against the RFP's requirements.

You will be given:
1) RFP details (title, agency, industry, capabilities, certifications, NAICS codes, location, description, attachments)
2) The user's profile (industries, capabilities, certifications, locations, agency experience, contract types, technology stack)
3) The rule-based score breakdown showing how the user scored in each category

Your task: Write a focused analysis (150–250 words) that covers:
- **What your company can fulfill** — Specific RFP requirements that align with your capabilities, certifications, industry experience, technology stack, or past agency work. Reference concrete overlaps.
- **Potential gaps** — Specific RFP requirements you do not currently demonstrate in your profile (missing certifications, unfamiliar agencies, scope areas not listed in capabilities, etc.)
- **Scope alignment** — How well the type of work described in the RFP matches your demonstrated experience

Format your response in markdown:
- Do NOT include a title or heading like "Capabilities Analysis" at the top — jump straight into the content
- Use **bold** for section headings (e.g., **What your company can fulfill**, **Potential gaps**, **Scope alignment**)
- Use bullet points for specific items
- Always refer to the reader as "you" and their business as "your company". Never use "the company" or "the contractor" in your output.
- Keep it scannable and factual — no encouragement or advice about improving the profile
- If the user's profile is missing, state that no profile is available and list what the RFP requires`;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      rfp,
      profile,
      breakdown,
    }: {
      rfp: Record<string, unknown>;
      profile: Record<string, unknown> | null;
      breakdown?: Array<{ category: string; points: number; maxPoints: number; status: string; detail: string }>;
    } = body;

    if (!rfp) {
      return NextResponse.json(
        { error: "rfp is required" },
        { status: 400 }
      );
    }

    const description = (rfp.description as string) || "";
    const attachmentRollup = (rfp as Record<string, unknown>).attachmentRollup;
    const hasAttachments = attachmentRollup && typeof attachmentRollup === "object";

    // Build compact profile summary
    let profileSummary = "No user profile available.";
    if (profile) {
      profileSummary = JSON.stringify(profile);
    }

    const clearances = Array.isArray(rfp.clearancesRequired) ? (rfp.clearancesRequired as string[]).join(", ") : "";
    const setAsides = Array.isArray(rfp.setAsideTypes) ? (rfp.setAsideTypes as string[]).join(", ") : "";
    const deliverables = Array.isArray(rfp.deliverables) ? (rfp.deliverables as string[]).slice(0, 5).join(", ") : "";

    const input = `RFP:
Title: ${rfp.title ?? "N/A"}
Agency: ${rfp.agency ?? "N/A"}
Industry: ${rfp.industry ?? "N/A"}
Location: ${rfp.location ?? "N/A"}
Contract type: ${rfp.contractType ?? "N/A"}
Capabilities sought: ${Array.isArray(rfp.capabilities) ? (rfp.capabilities as string[]).join(", ") : "N/A"}
Certifications required: ${Array.isArray(rfp.certifications) ? (rfp.certifications as string[]).join(", ") : "N/A"}
NAICS codes: ${Array.isArray(rfp.naicsCodes) ? (rfp.naicsCodes as string[]).join(", ") : "N/A"}
Clearances required: ${clearances || "N/A"}
Set-aside types: ${setAsides || "N/A"}
Deliverables: ${deliverables || "N/A"}
Estimated value: ${rfp.estimatedValue ?? "N/A"}

Description (excerpt):
${description.slice(0, 3000)}

${hasAttachments ? `Attachment data:\n${JSON.stringify(attachmentRollup).slice(0, 2000)}` : ""}

Company Profile:
${profileSummary}

Score Breakdown:
${JSON.stringify(breakdown ?? [])}

Produce the capabilities analysis:`;

    const result = await chatCompletion(
      [
        { role: "system", content: PROMPT },
        { role: "user", content: input },
      ],
      { temperature: 0.3, maxTokens: 500 }
    );

    const analysis = result.content?.trim() ?? null;

    return NextResponse.json({ analysis });
  } catch (err) {
    console.error("[capabilities-analysis] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate analysis" },
      { status: 500 }
    );
  }
}
