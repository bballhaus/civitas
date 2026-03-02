import { NextResponse } from "next/server";
import Groq from "groq-sdk";

const PROMPT = `You are an expert government contracting consultant. Given the full text of an RFP (Request for Proposal) description, produce a clear, structured summary of the contract's requirements.

You will be given:
1) RFP title, agency, and other metadata
2) The full RFP description text

Your task: Write a concise summary (approximately 150–250 words) that captures:
- **Scope & deliverables** – What the contractor must deliver
- **Key requirements** – Mandatory capabilities, certifications, or qualifications
- **Timeline & deadlines** – Important dates or milestones if mentioned
- **Contract terms** – Type of contract (e.g., fixed-price, T&M), estimated value if provided
- **Notable constraints** – Location requirements, security clearances, or other critical terms

Format your response in markdown for readability:
- Use **bold** for section headings (e.g., **Scope & Deliverables**, **Key Requirements**, **Timeline & Deadlines**)
- Use bullet points (- or *) for lists of requirements, deliverables, or dates
- Use short paragraphs between sections
- Keep it scannable so vendors can quickly understand whether to pursue the opportunity.`;

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
    if (!description.trim()) {
      return NextResponse.json(
        { error: "RFP description is required" },
        { status: 400 }
      );
    }

    const client = new Groq({ apiKey });
    const input = `RFP context:
Title: ${rfp.title ?? "N/A"}
Agency: ${rfp.agency ?? "N/A"}
Industry: ${rfp.industry ?? "N/A"}
Location: ${rfp.location ?? "N/A"}
Deadline: ${rfp.deadline ?? "N/A"}
Contract type: ${rfp.contractType ?? "N/A"}
Capabilities sought: ${Array.isArray(rfp.capabilities) ? (rfp.capabilities as string[]).join(", ") : "N/A"}
Certifications: ${Array.isArray(rfp.certifications) ? (rfp.certifications as string[]).join(", ") : "N/A"}
Estimated value: ${rfp.estimatedValue ?? "N/A"}

Full description:
${description.slice(0, 6000)}

Summarize the contract requirements:`;

    const completion = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: input },
      ],
      temperature: 0.3,
      max_tokens: 500,
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
