import { NextResponse } from "next/server";
import Groq from "groq-sdk";

const PROMPT = `You are an expert government contracting consultant creating an INTERNAL planning document for a company considering pursuing an RFP. This document is for internal use only—it is NOT a proposal to submit. It helps the company plan and decide whether to bid.

You will be given:
1) Complete RFP information: title, agency, description, requirements, deadline, estimated value, location, contract type, capabilities sought, certifications required, contact info, etc.
2) The company's full profile: company name, industries, capabilities, certifications, clearances, NAICS codes, service areas (cities/counties), agency experience, contract types, and size status

Your task: Write an internal Plan of Execution that outlines:

1. **Contract Requirements Summary** – What must be delivered according to the RFP: scope, deliverables, timeline, compliance requirements, certifications needed, and any critical terms or constraints.

2. **Capability Gap Analysis** – Compare what the RFP requires vs. what the company already has:
   - **Capabilities**: List required capabilities from the RFP. For each, state whether the company has it (from profile), partially has it, or would need to acquire it. Be specific.
   - **Certifications**: Required certifications vs. company’s certifications. Flag any gaps.
   - **Location/Service Area**: Whether the company’s service areas align with the RFP location. Note any travel or local presence needs.
   - **Agency Experience**: Whether the company has worked with this agency before. Note relevance.

3. **Action Items to Fulfill Requirements** – A prioritized list of what the company needs to do to be bid-ready: obtain certifications, build capability, form partnerships, gather documentation, etc. Include rough effort or timeline where helpful.

4. **Execution Phases** – If the company wins, outline high-level phases: kickoff, key milestones, resource needs, and critical path items based on the RFP scope.

5. **Risks & Considerations** – Identify gaps that are hard to close, capacity concerns, deadline pressure, or other factors the company should weigh before deciding to bid.

Use the company profile extensively to make the gap analysis accurate. Be direct and practical. This is an internal planning tool, so be candid about gaps and effort. Use clear headings and bullet points where helpful. Aim for approximately 600–1000 words. Write in third person ("The company...") or neutral ("Required...", "Gap:...").`;

const REFINE_PROMPT = `You are an expert government contracting consultant. The user has received a draft Plan of Execution and has provided feedback. Your task is to produce an improved version that incorporates their feedback.

You will be given:
1) The RFP context and company profile
2) The current draft plan
3) The user's feedback

Incorporate the feedback thoughtfully. Preserve the overall structure and quality. Make targeted changes based on what the user asked for. If the feedback is vague, make reasonable improvements. Output the full revised plan.`;

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error("[generate-plan-of-execution] GROQ_API_KEY not set");
      return NextResponse.json(
        { error: "GROQ_API_KEY not configured" },
        { status: 500 }
      );
    }

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

    const client = new Groq({ apiKey });
    const trimmedFeedback = (feedback ?? "").trim();
    const isRefinement = trimmedFeedback.length > 0;

    let systemPrompt = PROMPT;
    let userInput: string;

    if (isRefinement && currentPlan) {
      systemPrompt = REFINE_PROMPT;
      userInput = `RFP context:
${JSON.stringify(rfp, null, 2)}

Company Profile:
${profile ? JSON.stringify(profile, null, 2) : "No profile"}

Current draft plan:
---
${currentPlan}
---

User feedback:
${feedback?.trim() ?? ""}

Produce the full revised plan:`;
    } else {
      userInput = `RFP (full context):
${JSON.stringify(rfp, null, 2)}

Company Profile:
${profile ? JSON.stringify(profile, null, 2) : "No company profile provided. Create a generic plan structure."}`;
    }

    const completion = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userInput },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    });

    const plan =
      completion.choices[0]?.message?.content?.trim() ??
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
