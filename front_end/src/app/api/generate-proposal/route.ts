import { NextResponse } from "next/server";
import Groq from "groq-sdk";

const PROMPT = `You are an expert government contracting consultant helping a vendor write a professional proposal in response to an RFP (Request for Proposal).

You will be given:
1) Complete RFP information: title, agency, description, requirements, deadline, estimated value, location, contract type, capabilities sought, certifications required, contact info, and any reference to attachments or supplementary documents
2) The company's full profile: company name, industries, capabilities, certifications, clearances, NAICS codes, service areas (cities/counties), agency experience, contract types, and size status

Your task: Write a professional proposal draft tailored to this RFP. Structure it as:

1. **Executive Summary** – Brief overview of your company and why you are the right fit (2–3 paragraphs)
2. **Understanding of Requirements** – Show you understand the scope, deliverables, and key requirements from the RFP
3. **Approach & Methodology** – How you will execute the work, timeline, and key phases
4. **Relevant Experience & Qualifications** – Highlight experience with similar projects, the agency if applicable, and relevant certifications
5. **Why Choose Us** – Differentiators based on your profile that align with the RFP needs

Use the company profile extensively to personalize the proposal. Reference specific capabilities, certifications, locations, and past agency experience. Be professional and persuasive. If the RFP mentions attachments (e.g., "Attachment A", "see full packet"), acknowledge them and suggest the reader refer to those documents for additional detail. Write in the company's voice (first person plural: "We..."). Aim for approximately 800–1200 words. Use clear headings and short paragraphs.`;

const REFINE_PROMPT = `You are an expert government contracting consultant. The user has received a draft proposal and has provided feedback. Your task is to produce an improved version of the proposal that incorporates their feedback.

You will be given:
1) The RFP context and company profile
2) The current draft proposal
3) The user's feedback

Incorporate the feedback thoughtfully. Preserve the overall structure and quality. Make targeted changes based on what the user asked for. If the feedback is vague, make reasonable improvements. Output the full revised proposal.`;

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error("[generate-proposal] GROQ_API_KEY not set");
      return NextResponse.json(
        { error: "GROQ_API_KEY not configured" },
        { status: 500 }
      );
    }

    const body = await req.json();
    const {
      rfp,
      profile,
      currentProposal,
      feedback,
    }: {
      rfp: Record<string, unknown>;
      profile: Record<string, unknown> | null;
      currentProposal?: string;
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

    if (isRefinement && currentProposal) {
      systemPrompt = REFINE_PROMPT;
      userInput = `RFP context:
${JSON.stringify(rfp, null, 2)}

Company Profile:
${profile ? JSON.stringify(profile, null, 2) : "No profile"}

Current draft proposal:
---
${currentProposal}
---

User feedback:
${trimmedFeedback}

Produce the full revised proposal:`;
    } else {
      userInput = `RFP (full context):
${JSON.stringify(rfp, null, 2)}

Company Profile:
${profile ? JSON.stringify(profile, null, 2) : "No company profile provided. Write a generic proposal structure."}`;
    }

    const completion = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userInput },
      ],
      temperature: 0.4,
      max_tokens: 4096,
    });

    const proposal =
      completion.choices[0]?.message?.content?.trim() ?? "Unable to generate proposal.";

    return NextResponse.json({ proposal });
  } catch (err) {
    console.error("[generate-proposal] Error:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to generate proposal",
      },
      { status: 500 }
    );
  }
}
