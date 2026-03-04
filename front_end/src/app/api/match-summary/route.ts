import { NextResponse } from "next/server";
import Groq from "groq-sdk";

const PROMPT = `You are helping a vendor/contractor understand why an RFP (Request for Proposal) is or isn't a good match for their company.

Given:
1) The RFP details (title, agency, industry, capabilities, location, deadline, description snippet)
2) Attachment-derived data (NAICS codes, certifications, clearances, set-asides, deliverables) if available — this comes from the actual RFP attachment PDFs
3) The company's full profile (industries, capabilities, certifications, locations, agency experience, contract types)
4) A rule-based match summary with score, tier, and reasons
5) A per-category score breakdown showing how points were earned
6) Any disqualifiers (hard blockers like expired deadlines or missing clearances)

Your task: Write a short, natural 2-4 sentence summary explaining why this RFP is a good match (or why it isn't). Reference specific overlaps or gaps from the breakdown. When attachment-derived data is present, reference specific NAICS codes, certifications, or requirements from the attachments. If disqualified, explain clearly why. If a strong match, highlight the top strengths. If weak, suggest what profile updates might help. Keep it conversational and under 100 words. No bullet points.`;

export async function POST(req: Request) {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.error("[match-summary] GROQ_API_KEY not set");
      return NextResponse.json(
        { error: "GROQ_API_KEY not configured" },
        { status: 500 }
      );
    }

    const body = await req.json();
    const {
      rfp,
      profile,
      currentSummary,
      positiveReasons,
      negativeReasons,
      disqualifiers,
      breakdown,
      score,
      tier,
    }: {
      rfp: Record<string, unknown>;
      profile: Record<string, unknown> | null;
      currentSummary: string;
      positiveReasons?: string[];
      negativeReasons?: string[];
      disqualifiers?: string[];
      breakdown?: Array<{ category: string; points: number; maxPoints: number; status: string; detail: string }>;
      score?: number;
      tier?: string;
    } = body;

    if (!rfp || !currentSummary) {
      return NextResponse.json(
        { error: "rfp and currentSummary are required" },
        { status: 400 }
      );
    }

    const client = new Groq({ apiKey });

    // Build a compact RFP summary with attachment data highlighted
    const rfpSummary: Record<string, unknown> = {
      title: rfp.title,
      agency: rfp.agency,
      industry: rfp.industry,
      location: rfp.location,
      capabilities: rfp.capabilities,
      certifications: rfp.certifications,
      estimatedValue: rfp.estimatedValue,
    };

    // Include attachment-derived fields when present
    const rfpAny = rfp as Record<string, unknown>;
    if (Array.isArray(rfpAny.naicsCodes) && (rfpAny.naicsCodes as string[]).length > 0)
      rfpSummary.naicsCodes = rfpAny.naicsCodes;
    if (Array.isArray(rfpAny.clearancesRequired) && (rfpAny.clearancesRequired as string[]).length > 0)
      rfpSummary.clearancesRequired = rfpAny.clearancesRequired;
    if (Array.isArray(rfpAny.setAsideTypes) && (rfpAny.setAsideTypes as string[]).length > 0)
      rfpSummary.setAsideTypes = rfpAny.setAsideTypes;
    if (Array.isArray(rfpAny.deliverables) && (rfpAny.deliverables as string[]).length > 0)
      rfpSummary.deliverables = (rfpAny.deliverables as string[]).slice(0, 5);
    if (rfpAny.attachmentRollup && typeof rfpAny.attachmentRollup === "object") {
      const rollup = rfpAny.attachmentRollup as { summary?: string };
      if (rollup.summary) rfpSummary.attachmentSummary = rollup.summary;
    }

    const input = `RFP: ${JSON.stringify(rfpSummary)}
Profile: ${profile ? JSON.stringify(profile) : "No profile"}
Score: ${score ?? "unknown"}/100 (Tier: ${tier ?? "unknown"})
Rule-based summary: ${currentSummary}
Positive reasons: ${JSON.stringify(positiveReasons ?? [])}
Negative reasons: ${JSON.stringify(negativeReasons ?? [])}
Disqualifiers: ${JSON.stringify(disqualifiers ?? [])}
Score breakdown: ${JSON.stringify(breakdown ?? [])}`;

    const completion = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: input },
      ],
      temperature: 0.3,
      max_tokens: 200,
    });

    const summary =
      completion.choices[0]?.message?.content?.trim() ?? currentSummary;

    return NextResponse.json({ summary });
  } catch (err) {
    console.error("[match-summary] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to generate summary" },
      { status: 500 }
    );
  }
}
