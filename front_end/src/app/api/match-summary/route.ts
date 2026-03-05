import { NextResponse } from "next/server";
import Groq from "groq-sdk";

const PROMPT = `You are helping a vendor/contractor understand why an RFP (Request for Proposal) is or isn't a good match for their company.

Given:
1) The RFP details (title, agency, industry, capabilities, location, deadline, description snippet)
2) The company's full profile (industries, capabilities, certifications, locations, agency experience, contract types)
3) A rule-based match summary that lists reasons like "the deadline is still open", "industry aligns", "capabilities align: X"
4) Optional lists of positive and negative match reasons
5) Optional attachment-derived key requirements and constraints (e.g., certifications, clearances, set-asides, geography)

Your task: Write a short, natural 1-3 sentence summary explaining why this RFP is a good match (or why it might not be). Use the rule-based summary and reason lists as a starting point but make it more personalized and readable. When attachment-derived requirements are provided, explicitly mention important constraints (like certifications, clearances, set-asides, or geography) and whether the company appears to meet them. Reference specific overlaps. Keep it conversational and under 80 words. No bullet points.`;

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
    }: {
      rfp: Record<string, unknown>;
      profile: Record<string, unknown> | null;
      currentSummary: string;
      positiveReasons?: string[];
      negativeReasons?: string[];
    } = body;

    if (!rfp || !currentSummary) {
      return NextResponse.json(
        { error: "rfp and currentSummary are required" },
        { status: 400 }
      );
    }

    const client = new Groq({ apiKey });
    const input = `RFP: ${JSON.stringify(rfp)}
Profile: ${profile ? JSON.stringify(profile) : "No profile"}
Rule-based summary: ${currentSummary}
Positive reasons: ${
      Array.isArray(positiveReasons) ? JSON.stringify(positiveReasons) : "[]"
    }
Negative reasons: ${
      Array.isArray(negativeReasons) ? JSON.stringify(negativeReasons) : "[]"
    }`;

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
