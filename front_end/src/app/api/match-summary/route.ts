import { NextResponse } from "next/server";
import { chatCompletionStream } from "@/lib/llm";

// Streams a plain-text response so the detail page can render the summary
// progressively (first token in ~200-500ms vs ~1-3s for the full payload).
// Content-Type is text/plain — no JSON wrapper, no SSE framing. The client
// reads res.body via getReader() and accumulates chunks into state.
export const runtime = "nodejs";

const PROMPT = `You are helping a vendor/contractor understand why an RFP (Request for Proposal) is or isn't a good match for their business.

Given:
1) The RFP details (title, agency, industry, capabilities, location, deadline, description snippet)
2) The user's full profile (industries, capabilities, certifications, locations, agency experience, contract types)
3) A rule-based match summary that lists reasons like "the deadline is still open", "industry aligns", "capabilities align: X"
4) Optional lists of positive and negative match reasons
5) Optional attachment-derived key requirements and constraints (e.g., certifications, clearances, set-asides, geography)

Important scoring context:
- When an RFP does NOT specify a requirement for a category (e.g., no NAICS codes, no certifications), the user earns FULL points for that category. This means "no requirement = everyone qualifies" and is expected, not a flaw.
- A high score on a generic RFP (few specific requirements) is normal — the user isn't penalized for requirements that don't exist.
- Focus explanations on categories where there IS a specific RFP requirement and how the user matches or doesn't match.

Your task: Write two plain text paragraphs (no headings or "Part 1/Part 2" labels).

First paragraph: A very brief summary of what the RFP is actually asking for (scope, key requirements, type of work, agency/context). Do not mention the reader yet. 1–2 sentences.

Second paragraph: Why this RFP is or isn't a good match for you / your company. Be specific — name overlapping capabilities, industries, certifications, or NAICS codes that drive the score. When attachment-derived data is present, reference specific requirements from the attachments. If disqualified, explain clearly why. If a strong match, explain exactly which of your company's strengths align with which RFP requirements. If weak, explain which specific RFP requirements you don't meet. 2–4 sentences.

Rules:
- Always refer to the reader as "you" and their business as "your company". Never use "the company" or "the contractor" in your output.
- Do NOT suggest profile updates, improvements, or ways to strengthen the match
- Do NOT use filler phrases like "let's take a closer look", "to better understand", or "review the breakdown"
- Output exactly two paragraphs of plain text. No bullet points, no labels.`;

export async function POST(req: Request) {
  let body: {
    rfp?: Record<string, unknown>;
    profile?: Record<string, unknown> | null;
    currentSummary?: string;
    positiveReasons?: string[];
    negativeReasons?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    rfp,
    profile,
    currentSummary,
    positiveReasons,
    negativeReasons,
  } = body;

  if (!rfp || !currentSummary) {
    return NextResponse.json(
      { error: "rfp and currentSummary are required" },
      { status: 400 }
    );
  }

  const rfpAny = rfp as Record<string, unknown>;
  const naicsCodes = Array.isArray(rfpAny.naicsCodes) ? (rfpAny.naicsCodes as string[]).join(", ") : "";
  const clearances = Array.isArray(rfpAny.clearancesRequired) ? (rfpAny.clearancesRequired as string[]).join(", ") : "";
  const setAsides = Array.isArray(rfpAny.setAsideTypes) ? (rfpAny.setAsideTypes as string[]).join(", ") : "";
  const deliverables = Array.isArray(rfpAny.deliverables) ? (rfpAny.deliverables as string[]).slice(0, 5).join(", ") : "";
  const attachmentRollup = rfpAny.attachmentRollup;
  const hasAttachments = attachmentRollup && typeof attachmentRollup === "object";

  const input = `RFP: ${JSON.stringify(rfp)}
${naicsCodes ? `NAICS codes: ${naicsCodes}` : ""}
${clearances ? `Clearances required: ${clearances}` : ""}
${setAsides ? `Set-aside types: ${setAsides}` : ""}
${deliverables ? `Key deliverables: ${deliverables}` : ""}
${hasAttachments ? `Attachment data: ${JSON.stringify(attachmentRollup).slice(0, 1500)}` : ""}
Profile: ${profile ? JSON.stringify(profile) : "No profile"}
Rule-based summary: ${currentSummary}
Positive reasons: ${
    Array.isArray(positiveReasons) ? JSON.stringify(positiveReasons) : "[]"
  }
Negative reasons: ${
    Array.isArray(negativeReasons) ? JSON.stringify(negativeReasons) : "[]"
  }`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chatCompletionStream(
          [
            { role: "system", content: PROMPT },
            { role: "user", content: input },
          ],
          {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
            temperature: 0.3,
            // Prompt asks for 1-2 + 2-4 sentences with concrete citations.
            // 280 was tight enough to truncate mid-paragraph when Haiku
            // included multiple capability/NAICS references; 500 is enough
            // headroom for both paragraphs while still keeping the response
            // tight. First-byte latency is unaffected (streaming).
            maxTokens: 500,
          },
        )) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (err) {
        console.error("[match-summary] streaming error:", err);
        // The stream may have emitted partial output already; closing with
        // an error surfaces as a network-level failure on the client, which
        // its catch handler treats as "fall back to rule-based summary".
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      // Defeat any upstream buffering (some CDNs/proxies hold small text
      // bodies until they hit a buffer threshold, which would defeat the
      // point of streaming).
      "X-Accel-Buffering": "no",
    },
  });
}
