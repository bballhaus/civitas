import { NextResponse } from "next/server";
import Groq from "groq-sdk";

const PROMPT = `You are an expert government contracting consultant. Given an RFP and a company profile, produce a concise capabilities analysis that compares the company's qualifications against the RFP's requirements.

You will be given:
1) RFP details (title, agency, industry, capabilities, certifications, NAICS codes, location, description, attachments)
2) The company's profile (industries, capabilities, certifications, locations, agency experience, contract types, technology stack)
3) The rule-based score breakdown showing how the company scored in each category

Your task: Write a focused analysis (150–250 words) that covers:
- **What the company can fulfill** — Specific RFP requirements that align with the company's capabilities, certifications, industry experience, technology stack, or past agency work. Reference concrete overlaps.
- **Potential gaps** — Specific RFP requirements the company does not currently demonstrate in their profile (missing certifications, unfamiliar agencies, scope areas not listed in capabilities, etc.)
- **Scope alignment** — How well the type of work described in the RFP matches the company's demonstrated experience

Format your response in markdown:
- Use **bold** for section headings
- Use bullet points for specific items
- Keep it scannable and factual — no encouragement or advice about improving the profile
- If the company profile is missing, state that no profile is available and list what the RFP requires`;

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error("[capabilities-analysis] GROQ_API_KEY not set");
      return NextResponse.json(
        { error: "GROQ_API_KEY not configured" },
        { status: 500 }
      );
    }

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

    const client = new Groq({ apiKey });

    const description = (rfp.description as string) || "";
    const attachmentRollup = (rfp as Record<string, unknown>).attachmentRollup;
    const hasAttachments = attachmentRollup && typeof attachmentRollup === "object";

    // Build compact profile summary
    let profileSummary = "No company profile available.";
    if (profile) {
      profileSummary = JSON.stringify(profile);
    }

    const input = `RFP:
Title: ${rfp.title ?? "N/A"}
Agency: ${rfp.agency ?? "N/A"}
Industry: ${rfp.industry ?? "N/A"}
Location: ${rfp.location ?? "N/A"}
Contract type: ${rfp.contractType ?? "N/A"}
Capabilities sought: ${Array.isArray(rfp.capabilities) ? (rfp.capabilities as string[]).join(", ") : "N/A"}
Certifications required: ${Array.isArray(rfp.certifications) ? (rfp.certifications as string[]).join(", ") : "N/A"}
NAICS codes: ${Array.isArray(rfp.naicsCodes) ? (rfp.naicsCodes as string[]).join(", ") : "N/A"}
Estimated value: ${rfp.estimatedValue ?? "N/A"}

Description (excerpt):
${description.slice(0, 3000)}

${hasAttachments ? `Attachment data:\n${JSON.stringify(attachmentRollup).slice(0, 2000)}` : ""}

Company Profile:
${profileSummary}

Score Breakdown:
${JSON.stringify(breakdown ?? [])}

Produce the capabilities analysis:`;

    const completion = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: input },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    const analysis =
      completion.choices[0]?.message?.content?.trim() ?? null;

    return NextResponse.json({ analysis });
  } catch (err) {
    console.error("[capabilities-analysis] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate analysis" },
      { status: 500 }
    );
  }
}
