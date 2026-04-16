import { NextResponse } from "next/server";
import { chatCompletion } from "@/lib/llm";

const PROMPT = `You are an expert government contracting consultant creating an INTERNAL planning document for a vendor considering pursuing an RFP. This document is for internal use only—it is NOT a proposal to submit. It helps the user plan and decide whether to bid.

You will be given:
1) Complete RFP information: title, agency, description, requirements, deadline, estimated value, location, contract type, capabilities sought, certifications required, contact info, etc.
2) The user's full profile: company name, industries, capabilities, certifications, clearances, NAICS codes, service areas (cities/counties), agency experience, contract types, and size status

Your task: Write an internal Plan of Execution that outlines:

1. **Contract Requirements Summary** – What must be delivered according to the RFP: scope, deliverables, timeline, compliance requirements, certifications needed, and any critical terms or constraints.

2. **Capability Gap Analysis** – Compare what the RFP requires vs. what you already have:
   - **Capabilities**: List required capabilities from the RFP. For each, state whether you have it (from profile), partially have it, or would need to acquire it. Be specific.
   - **Certifications**: Required certifications vs. your certifications. Flag any gaps.
   - **Location/Service Area**: Whether your service areas align with the RFP location. Note any travel or local presence needs.
   - **Agency Experience**: Whether you have worked with this agency before. Note relevance.

3. **Action Items to Close Gaps** – This is the MOST IMPORTANT section. For EVERY gap identified in the Capability Gap Analysis, provide a definitive, concrete action item. Do NOT be vague. Each action item MUST include:
   - **What** specifically needs to be done (e.g. "Apply for ISO 27001 certification through [registrar]", NOT "consider getting certified")
   - **How** to accomplish it (specific steps, resources, or partners needed)
   - **Timeline** estimate (e.g. "2-4 weeks", "before submission deadline")
   - **Priority** level (Critical / High / Medium / Low) based on whether it's a hard requirement or a competitive advantage

   Organize action items into categories:
   - **Certifications & Compliance**: Steps to obtain missing certifications or meet compliance requirements
   - **Capability Building**: How to build or acquire missing technical/service capabilities (hiring, training, subcontracting, partnering)
   - **Documentation & Bid Prep**: Specific documents to prepare, past performance references to gather, forms to complete
   - **Partnerships & Teaming**: If gaps are too large to close alone, identify specific types of teaming partners or subcontractors needed

   Be decisive and actionable — use language like "You must...", "Obtain...", "Partner with...", "Hire...", "Register for..." rather than "Consider...", "You may want to...", "It might be helpful to...".

CRITICAL: Action items must be about REAL-WORLD PREPARATION to win and execute the contract — NOT about updating their profile, capabilities list, or any software system. Never say "review and update your capabilities list", "update your profile", "update your certifications list", "update your service area list", or similar. Instead, focus on tangible actions like obtaining certifications, hiring staff, acquiring equipment, establishing local presence, gathering references, preparing bid documents, and partnering with subcontractors. The profile data you receive is just context about the company — do not reference it as something to be edited.

4. **Execution Phases** – If you win, outline high-level phases: kickoff, key milestones, resource needs, and critical path items based on the RFP scope.

5. **Risks & Considerations** – Identify gaps that are hard to close, capacity concerns, deadline pressure, or other factors you should weigh before deciding to bid. For each risk, suggest a concrete mitigation strategy.

Use the user's profile extensively to make the gap analysis accurate. Be direct and practical. This is an internal planning tool, so be candid about gaps and effort. Use clear headings and bullet points where helpful. Aim for approximately 800–1200 words. Always address the reader as "you" and refer to their business as "your company". Never use "the company" or "the contractor" in your output. Use second person ("Your company...", "You...") or neutral ("Required...", "Gap:...").`;

const REFINE_PROMPT = `You are an expert government contracting consultant. The user has received a draft Plan of Execution and has provided feedback. Your task is to produce an improved version that incorporates their feedback.

You will be given:
1) The RFP context and user profile
2) The current draft plan
3) The user's feedback

Incorporate the feedback thoughtfully. Preserve the overall structure and quality. Make targeted changes based on what the user asked for. If the feedback is vague, make reasonable improvements. Output the full revised plan. Always refer to the reader as "you" and their business as "your company"—never "the company" or "the contractor."`;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      rfp,
      profile,
      currentPlan,
      feedback,
    }: {
      rfp: Record<string, unknown>;
      profile: Record<string, unknown> | null;
      currentPlan?: string;
      feedback?: string;
    } = body;

    if (!rfp) {
      return NextResponse.json(
        { error: "rfp is required" },
        { status: 400 }
      );
    }

    const trimmedFeedback = (feedback ?? "").trim();
    const isRefinement = trimmedFeedback.length > 0;

    let systemPrompt = PROMPT;
    let userInput: string;

    if (isRefinement && currentPlan) {
      systemPrompt = REFINE_PROMPT;
      userInput = `RFP context:
${JSON.stringify(rfp, null, 2)}

User Profile:
${profile ? JSON.stringify(profile, null, 2) : "No profile"}

Current draft plan:
---
${currentPlan}
---

User feedback:
${trimmedFeedback}

Produce the full revised plan:`;
    } else {
      userInput = `RFP (full context):
${JSON.stringify(rfp, null, 2)}

User Profile:
${profile ? JSON.stringify(profile, null, 2) : "No user profile provided. Create a generic plan structure."}`;
    }

    const result = await chatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userInput },
      ],
      { temperature: 0.3, maxTokens: 4096 }
    );

    const plan =
      result.content?.trim() ??
      "Unable to generate plan of execution.";

    return NextResponse.json({ plan });
  } catch (err) {
    console.error("[generate-plan-of-execution] Error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to generate plan of execution",
      },
      { status: 500 }
    );
  }
}
