import { NextResponse } from "next/server";
import Groq from "groq-sdk";

const PROMPT = `You are helping a vendor/contractor understand why an RFP (Request for Proposal) is or isn't a good match for their company.

Given:
1) The RFP details (title, agency, industry, capabilities, location, deadline, description snippet)
2) The company's full profile (industries, capabilities, certifications, locations, agency experience, contract types)
3) A rule-based match summary with score, tier, and reasons
4) A per-category score breakdown showing how points were earned
5) Any disqualifiers (hard blockers like expired deadlines or missing clearances)

Your task: Write a short, natural 2-4 sentence summary explaining why this RFP is a good match (or why it isn't). Reference specific overlaps or gaps from the breakdown. If disqualified, explain clearly why. If a strong match, highlight the top strengths. If weak, suggest what profile updates might help. Keep it conversational and under 100 words. No bullet points.`;

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
    const input = `RFP: ${JSON.stringify(rfp)}
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
