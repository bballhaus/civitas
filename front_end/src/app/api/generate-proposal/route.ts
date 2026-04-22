import { NextResponse } from "next/server";
import { chatCompletion } from "@/lib/llm";
import { extractTextFromPdf } from "@/lib/extraction";

export const runtime = "nodejs";

const PROMPT_WITHOUT_STYLE = `You are an expert government contracting consultant helping a vendor write a professional proposal in response to an RFP (Request for Proposal).

You will be given:
1) Complete RFP information: title, agency, description, requirements, deadline, estimated value, location, contract type, capabilities sought, certifications required, contact info, and any reference to attachments or supplementary documents
2) The user's full profile: company name, industries, capabilities, certifications, clearances, NAICS codes, service areas (cities/counties), agency experience, contract types, and size status

Your task: Write a professional proposal draft tailored to this RFP. Structure it as:

1. **Executive Summary** – Brief overview of your company and why you are the right fit (2–3 paragraphs)
2. **Understanding of Requirements** – Show you understand the scope, deliverables, and key requirements from the RFP
3. **Approach & Methodology** – How you will execute the work, timeline, and key phases
4. **Relevant Experience & Qualifications** – Highlight experience with similar projects, the agency if applicable, and relevant certifications
5. **Why Choose Us** – Differentiators based on your profile that align with the RFP needs

Use the user's profile extensively to personalize the proposal. Reference specific capabilities, certifications, locations, and past agency experience. Be professional and persuasive. If the RFP mentions attachments (e.g., "Attachment A", "see full packet"), acknowledge them and suggest the reader refer to those documents for additional detail. Write in first person plural ("We...", "our company"). Never refer to the vendor as "the company" or "the contractor" in the proposal text. Aim for approximately 800–1200 words. Use clear headings and short paragraphs.`;

const PROMPT_WITH_STYLE = `You are an expert government contracting consultant helping a vendor write a professional proposal in response to an RFP (Request for Proposal).

You will be given:
1) Complete RFP information: title, agency, description, requirements, deadline, estimated value, location, contract type, capabilities sought, certifications required, contact info, and any reference to attachments or supplementary documents
2) The user's full profile: company name, industries, capabilities, certifications, clearances, NAICS codes, service areas (cities/counties), agency experience, contract types, and size status
3) Examples of the user's past successful proposals/contracts — use these as a STYLE REFERENCE

Your task: Write a professional proposal draft tailored to this RFP. Structure it as:

1. **Executive Summary** – Brief overview of your company and why you are the right fit (2–3 paragraphs)
2. **Understanding of Requirements** – Show you understand the scope, deliverables, and key requirements from the RFP
3. **Approach & Methodology** – How you will execute the work, timeline, and key phases
4. **Relevant Experience & Qualifications** – Highlight experience with similar projects, the agency if applicable, and relevant certifications
5. **Why Choose Us** – Differentiators based on your profile that align with the RFP needs

CRITICAL STYLE INSTRUCTIONS: You MUST closely mimic the writing style, tone, vocabulary, sentence structure, and formatting patterns from the user's past proposals provided below. Pay attention to:
- How they open sections and paragraphs
- Their level of formality and technical detail
- How they describe capabilities and experience
- Their use of bullet points, numbered lists, or prose paragraphs
- Specific phrases, transitions, and persuasive language they favor
- How they address the client/agency

The new proposal should read as if the same person/team wrote it. Adapt the content to the new RFP while preserving the company's established voice.

Use the user's profile extensively to personalize the proposal. Reference specific capabilities, certifications, locations, and past agency experience. Be professional and persuasive. If the RFP mentions attachments (e.g., "Attachment A", "see full packet"), acknowledge them and suggest the reader refer to those documents for additional detail. Write in first person plural ("We...", "our company"). Never refer to the vendor as "the company" or "the contractor" in the proposal text. Aim for approximately 800–1200 words. Use clear headings and short paragraphs.`;

const REFINE_PROMPT = `You are an expert government contracting consultant. The user has received a draft proposal and has provided feedback. Your task is to produce an improved version of the proposal that incorporates their feedback.

You will be given:
1) The RFP context and company profile
2) The current draft proposal
3) The user's feedback

Incorporate the feedback thoughtfully. Preserve the overall structure and quality. Make targeted changes based on what the user asked for. If the feedback is vague, make reasonable improvements. Output the full revised proposal. Keep the proposal in first person plural (We/our). Never refer to the vendor as "the company" or "the contractor."`;

/**
 * Fetch a document from a URL and extract its text content.
 * Supports PDF files. Returns null on failure.
 */
async function extractTextFromUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());

    // Try PDF extraction
    if (url.toLowerCase().endsWith(".pdf") || response.headers.get("content-type")?.includes("pdf")) {
      const text = await extractTextFromPdf(buffer);
      return text?.trim() || null;
    }

    // Try plain text for other formats
    const text = buffer.toString("utf-8").trim();
    return text || null;
  } catch (e) {
    console.warn(`[generate-proposal] Failed to extract text from ${url}:`, e);
    return null;
  }
}

/**
 * Fetch and extract text from multiple document URLs in parallel.
 * Returns concatenated text from all successfully extracted documents.
 */
async function extractPastProposalTexts(urls: string[]): Promise<string> {
  if (!urls || urls.length === 0) return "";

  const results = await Promise.all(
    urls.map((url) => extractTextFromUrl(url))
  );

  const texts = results.filter((t): t is string => t !== null && t.length > 0);
  if (texts.length === 0) return "";

  // Cap total text to ~80K chars to stay within Groq context limits
  const MAX_TOTAL_CHARS = 80000;
  let totalChars = 0;
  const cappedTexts: string[] = [];
  for (const text of texts) {
    if (totalChars + text.length > MAX_TOTAL_CHARS) {
      const remaining = MAX_TOTAL_CHARS - totalChars;
      if (remaining > 500) {
        cappedTexts.push(text.slice(0, remaining) + "\n[... truncated ...]");
      }
      break;
    }
    cappedTexts.push(text);
    totalChars += text.length;
  }

  return cappedTexts
    .map((text, i) => `--- Past Proposal ${i + 1} ---\n${text}`)
    .join("\n\n");
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      rfp,
      profile,
      currentProposal,
      feedback,
      pastDocumentUrls,
    }: {
      rfp: Record<string, unknown>;
      profile: Record<string, unknown> | null;
      currentProposal?: string;
      feedback?: string;
      pastDocumentUrls?: string[];
    } = body;

    if (!rfp) {
      return NextResponse.json(
        { error: "rfp is required" },
        { status: 400 }
      );
    }

    // Extract text from past proposals for style reference (non-blocking on failure)
    let pastProposalText = "";
    if (pastDocumentUrls && pastDocumentUrls.length > 0) {
      try {
        pastProposalText = await extractPastProposalTexts(pastDocumentUrls);
      } catch (e) {
        console.warn("[generate-proposal] Failed to extract past proposals:", e);
      }
    }

    const hasStyleReference = pastProposalText.length > 0;

    const trimmedFeedback = (feedback ?? "").trim();
    const isRefinement = trimmedFeedback.length > 0;

    let systemPrompt = hasStyleReference ? PROMPT_WITH_STYLE : PROMPT_WITHOUT_STYLE;
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

      if (hasStyleReference) {
        userInput += `

STYLE REFERENCE — Past Successful Proposals (mimic this writing style closely):
${pastProposalText}`;
      }
    }

    const result = await chatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userInput },
      ],
      { temperature: 0.4, maxTokens: 4096 }
    );

    const proposal = result.content?.trim() ?? "Unable to generate proposal.";

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
