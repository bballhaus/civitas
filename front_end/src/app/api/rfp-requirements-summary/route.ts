import { NextResponse } from "next/server";
import Groq from "groq-sdk";

const PROMPT = `You are an expert government contracting consultant. Given the full text of an RFP (Request for Proposal) description and any pre-extracted key requirements from attachments, produce a clear, structured summary of the contract's requirements.

You will be given:
1) RFP title, agency, and other metadata
2) The full RFP description text
3) Optionally, an attachmentRollup object containing about-RFP summary text, key requirement bullets, and combined constraints extracted from attachments

Your task: Write a concise summary (approximately 150–300 words) with these sections IN ORDER:

**Deliverables**
This is the MOST IMPORTANT section. List every concrete deliverable, work item, or service the contractor must provide as bullet points. Be specific — extract exact tasks, quantities, materials, and measurable outputs from the description and attachments. Examples: "Remove and replace 500 LF of concrete pavement", "Provide 24/7 janitorial services for Building A". If the RFP is vague, note what information is missing.

**Key Requirements**
Bullet-point any mandatory qualifications: certifications, licenses, experience minimums, insurance, bonding, or technical capabilities required.

**Timeline & Deadlines**
Important dates, milestones, or contract duration. Include bid due date if mentioned.

**Contract Terms**
Contract type, estimated value, location, and any notable constraints (set-asides, security clearances, prevailing wage, etc.).

Formatting rules:
- Use **bold** for each section heading
- Use bullet points (- ) for ALL deliverables and requirements — never write deliverables as a paragraph
- Keep it scannable so vendors can quickly decide whether to pursue
- Address the reader as "you" / "your company" — do not say "the contractor"
- If the RFP description is too brief to extract specific deliverables, say so clearly and recommend reviewing the attached documents`;

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error("[rfp-requirements-summary] GROQ_API_KEY not set");
      return NextResponse.json(
        { error: "GROQ_API_KEY not configured" },
        { status: 500 }
      );
    }

    const body = await req.json();
    const {
      rfp,
    }: {
      rfp: Record<string, unknown>;
    } = body;

    if (!rfp) {
      return NextResponse.json(
        { error: "rfp is required" },
        { status: 400 }
      );
    }

    const description = (rfp.description as string) || "";
    const attachmentRollup = (rfp as any).attachmentRollup;
    if (!description.trim()) {
      return NextResponse.json(
        { error: "RFP description is required" },
        { status: 400 }
      );
    }

    const client = new Groq({ apiKey });

    // When attachment data is present, it's the most valuable context — give it more room
    const hasAttachments = attachmentRollup && (attachmentRollup.text || attachmentRollup.summary);
    const descriptionSlice = hasAttachments ? 3000 : 6000;
    const attachmentSlice = 3000;

    // Build structured attachment context for the LLM
    const naicsCodes = Array.isArray(rfp.naicsCodes) ? (rfp.naicsCodes as string[]).join(", ") : "";
    const clearances = Array.isArray((rfp as any).clearancesRequired) ? ((rfp as any).clearancesRequired as string[]).join(", ") : "";
    const setAsides = Array.isArray((rfp as any).setAsideTypes) ? ((rfp as any).setAsideTypes as string[]).join(", ") : "";
    const deliverables = Array.isArray((rfp as any).deliverables) ? ((rfp as any).deliverables as string[]).join(", ") : "";

    const input = `RFP context:
Title: ${rfp.title ?? "N/A"}
Agency: ${rfp.agency ?? "N/A"}
Industry: ${rfp.industry ?? "N/A"}
Location: ${rfp.location ?? "N/A"}
Deadline: ${rfp.deadline ?? "N/A"}
Contract type: ${rfp.contractType ?? "N/A"}
Capabilities sought: ${Array.isArray(rfp.capabilities) ? (rfp.capabilities as string[]).join(", ") : "N/A"}
Certifications: ${Array.isArray(rfp.certifications) ? (rfp.certifications as string[]).join(", ") : "N/A"}
NAICS codes: ${naicsCodes || "N/A"}
Clearances required: ${clearances || "N/A"}
Set-aside types: ${setAsides || "N/A"}
Deliverables: ${deliverables || "N/A"}
Estimated value: ${rfp.estimatedValue ?? "N/A"}
Contract duration: ${(rfp as any).contractDuration ?? "N/A"}

Full description:
${description.slice(0, descriptionSlice)}

Attachment-derived summary and constraints (if any):
${hasAttachments ? JSON.stringify(attachmentRollup).slice(0, attachmentSlice) : "None provided"}

Summarize the contract requirements:`;

    const completion = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: input },
      ],
      temperature: 0.3,
      max_tokens: 700,
    });

    const summary =
      completion.choices[0]?.message?.content?.trim() ?? description.slice(0, 500);

    return NextResponse.json({ summary });
  } catch (err) {
    console.error("[rfp-requirements-summary] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate summary" },
      { status: 500 }
    );
  }
}
