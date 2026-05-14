// v2 contract upload pipeline (Architecture-v2 § 6).
//
//   text extract → PII redact → classify → branch
//     ├── rfp_solicitation → guardrail (no extraction, redirect UI)
//     └── everything else → targeted extractor → claims[] → DB (pending)
//
// Each fact extracted gets its own row in `claims` with snippet, confidence
// (LLM × source-type multiplier), and status='pending'. Profile tables are
// NOT touched until the user accepts on the review screen — that's the
// hard rule from § 6.5 that prevents re-extraction from silently overwriting
// edits.

import { chatCompletion } from "@/lib/llm";
import { extractTextFromPdf } from "@/lib/extraction";
import { redactPii } from "@/lib/pii-redaction";
import { db } from "@/db/client";
import { claims, type Contract } from "@/db/schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DocumentType =
  | "proposal"
  | "executed_contract"
  | "capability_statement"
  | "license_doc"
  | "rfp_solicitation"
  | "other";

export type ContractStatus = "won" | "lost" | "in_progress" | "unknown" | null;

export interface ClassifierResult {
  documentType: DocumentType;
  contractStatus: ContractStatus;
  confidence: number;
  reasoning: string;
}

export interface ExtractedClaim {
  fieldPath: string;
  value: string;
  snippet: string | null;
  confidence: number; // post-multiplier
}

export interface PipelineResult {
  documentType: DocumentType;
  contractStatus: ContractStatus;
  classifierConfidence: number;
  isRfpSolicitation: boolean;
  // Number of PII matches redacted before the LLM saw the text.
  piiRedactedCount: number;
  claimsWritten: number;
  // null when documentType === 'rfp_solicitation' (skip extraction).
  extractedText: string | null;
}

// Hard cap on text sent to the LLM. Matches existing extractor budgets.
const MAX_CHARS = 50_000;
const CLASSIFIER_HEAD_CHARS = 3000;

// Models. Centralized so the spec's choice (Haiku 4.5 classify, Sonnet 4.6
// extract) is one edit away.
const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";
const EXTRACTOR_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Source-type confidence multipliers (spec § 6.4 table)
// ---------------------------------------------------------------------------

function sourceTypeMultiplier(
  documentType: DocumentType,
  contractStatus: ContractStatus,
): number {
  if (documentType === "executed_contract") return 1.0;
  if (documentType === "proposal") {
    if (contractStatus === "won") return 0.9;
    if (contractStatus === "lost") return 0.7;
    if (contractStatus === "in_progress") return 0.7;
    return 0.75; // unknown / null
  }
  if (documentType === "capability_statement") return 0.75;
  if (documentType === "license_doc") return 1.0;
  if (documentType === "other") return 0.5;
  return 0.5;
}

// ---------------------------------------------------------------------------
// Stage 1 — Classifier (Haiku, temperature 0)
// ---------------------------------------------------------------------------

const CLASSIFIER_PROMPT = `You classify procurement documents uploaded by a contractor about their own
company. Given the first ~3000 characters, return document_type, contract_status
(when applicable), and confidence.

document_type values:
- proposal:             a pitch the contractor wrote in response to an RFP
- executed_contract:    a signed/awarded agreement (post-award document)
- capability_statement: marketing material describing what the company does
                        (brochures, "about us" docs, company profiles, capability
                        statements)
- license_doc:          a license certificate, registration, or credential
- rfp_solicitation:     the AGENCY's RFP itself, not the contractor's response
- other:                anything else (resumes, financial statements, etc.)

How to distinguish proposal vs. rfp_solicitation:
  RFP markers (point of view = agency requesting work):
    "vendor shall", "the contractor must", "minimum qualifications",
    "submission requirements", "evaluation criteria", "scope of work"
    written in third person about a hypothetical bidder
  Proposal markers (point of view = contractor pitching):
    "we propose", "our team", "our approach", "we offer",
    written in first person from the contractor's side

contract_status (only for proposal or executed_contract):
- won:          contract was awarded to the contractor (look for award letter,
                signed agreement, references to performance)
- lost:         submitted but not awarded
- in_progress:  draft, not yet submitted, or awaiting decision
- unknown:      can't tell from the document
For executed_contract, contract_status is always "won".

Return JSON only:
{
  "document_type": "<type>",
  "contract_status": "<status or null>",
  "confidence": <0-1>,
  "reasoning": "<one sentence>"
}`;

export async function classifyDocument(text: string): Promise<ClassifierResult> {
  const head = text.slice(0, CLASSIFIER_HEAD_CHARS);
  const result = await chatCompletion(
    [
      { role: "system", content: CLASSIFIER_PROMPT },
      { role: "user", content: head },
    ],
    { model: CLASSIFIER_MODEL, temperature: 0 },
  );
  const parsed = parseJsonOrThrow(result.content);
  const documentType = parsed.document_type as DocumentType;
  const contractStatusRaw = parsed.contract_status;
  const contractStatus: ContractStatus =
    contractStatusRaw === "won" ||
    contractStatusRaw === "lost" ||
    contractStatusRaw === "in_progress" ||
    contractStatusRaw === "unknown"
      ? contractStatusRaw
      : null;

  // Spec § 6.4: executed_contract is implicitly won regardless of what the
  // model returns.
  const finalStatus: ContractStatus =
    documentType === "executed_contract" ? "won" : contractStatus;

  return {
    documentType,
    contractStatus: finalStatus,
    confidence: Number(parsed.confidence) || 0,
    reasoning: String(parsed.reasoning ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — Targeted extractors (Sonnet, temperature 0.1, JSON only)
// ---------------------------------------------------------------------------

const COMMON_EXTRACTOR_TAIL = `

Return a JSON object with a single \`claims\` array. Each claim is:
{
  "field_path": "<one of: specialties.value | capabilities.value | licenses.class | certifications.canonical | work_areas.name | agency_relationships.agency | profile.year_founded | profile.employee_band | profile.website | profile.company_name>",
  "value": "<the extracted value>",
  "snippet": "<exact text from the document that justifies the claim, ~20-60 words>",
  "confidence": <0-1, your raw confidence before any external multiplier>
}

Only return JSON, no prose, no markdown fences.`;

const PROPOSAL_PROMPT = `You extract structured facts from a contractor's proposal document.

Extract: contractor_name, role (prime/sub), agency, contract_value, duration,
start_date, end_date, license_classes, certifications_held, specialties
(1-3 from the scope), capabilities (broader from scope), naics_codes,
work_locations, scope_summary.${COMMON_EXTRACTOR_TAIL}`;

const EXECUTED_CONTRACT_PROMPT = `You extract structured facts from an executed (signed) contract.

Same fields as a proposal extractor, but the document is post-award and the
scope is fixed. Be precise — don't invent fields the document doesn't show.${COMMON_EXTRACTOR_TAIL}`;

const CAPABILITY_STATEMENT_PROMPT = `You extract structured facts from a contractor's capability statement
(marketing brochure / about-us / company profile).

Extract: company_name, year_founded, employee_count, primary_specialties,
capabilities, licenses, certifications, work_areas, agency_history
(named past clients). No contract value, agency, or dates expected.${COMMON_EXTRACTOR_TAIL}`;

const LICENSE_DOC_PROMPT = `You extract a single license credential from a license document.

Return JSON: {"claims": [{"field_path": "licenses.class", "value": "<class>",
"snippet": "<short quote>", "confidence": <0-1>}, ...]}.
You may add a second claim with field_path="licenses.number" or
"licenses.expires_on" if those are clearly stated.

No prose, no markdown.`;

const OTHER_PROMPT = `Best-effort fact extraction on a miscellaneous contractor document. Only
emit claims you're confident about — use field_path values from the catalog
listed below.${COMMON_EXTRACTOR_TAIL}`;

function extractorPromptFor(documentType: DocumentType): string | null {
  switch (documentType) {
    case "proposal":
      return PROPOSAL_PROMPT;
    case "executed_contract":
      return EXECUTED_CONTRACT_PROMPT;
    case "capability_statement":
      return CAPABILITY_STATEMENT_PROMPT;
    case "license_doc":
      return LICENSE_DOC_PROMPT;
    case "other":
      return OTHER_PROMPT;
    case "rfp_solicitation":
      return null; // guardrail — never extract
  }
}

export async function extractClaims(
  documentType: DocumentType,
  contractStatus: ContractStatus,
  redactedText: string,
): Promise<ExtractedClaim[]> {
  const prompt = extractorPromptFor(documentType);
  if (!prompt) return []; // rfp_solicitation guardrail

  // Status-specific instruction nudge (spec § 6.4 proposal extractor).
  let userText = redactedText;
  if (documentType === "proposal" && contractStatus === "lost") {
    userText = `[STATUS: LOST — bid amounts are aspirational, not delivered. Skip contract_value claims.]\n\n${userText}`;
  }

  const result = await chatCompletion(
    [
      { role: "system", content: prompt },
      { role: "user", content: userText.slice(0, MAX_CHARS) },
    ],
    { model: EXTRACTOR_MODEL, temperature: 0.1 },
  );

  const parsed = parseJsonOrThrow(result.content);
  const rawClaims = Array.isArray(parsed.claims) ? parsed.claims : [];
  const multiplier = sourceTypeMultiplier(documentType, contractStatus);

  const out: ExtractedClaim[] = [];
  for (const c of rawClaims) {
    if (!c || typeof c !== "object") continue;
    const field = typeof c.field_path === "string" ? c.field_path : null;
    const value = typeof c.value === "string" ? c.value.trim() : "";
    if (!field || !value) continue;
    const rawConf = Number(c.confidence);
    const llmConf = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, rawConf)) : 0.5;
    out.push({
      fieldPath: field,
      value,
      snippet: typeof c.snippet === "string" ? c.snippet : null,
      confidence: Math.round(llmConf * multiplier * 100) / 100,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Top-level driver: text extraction → PII redact → classify → extract → DB
// ---------------------------------------------------------------------------

export async function runContractPipeline(
  contract: Contract,
  fileBuffer: Buffer,
): Promise<PipelineResult> {
  // 1. Text extraction
  const rawText = await extractTextFromFile(fileBuffer, contract.originalFilename);

  // 2. PII redaction (BEFORE truncation, per spec § 7)
  const redactionResult = redactPii(rawText);
  const redactedText = redactionResult.text.slice(0, MAX_CHARS);

  // 3. Classify
  const cls = await classifyDocument(redactedText);

  // 4. Branch on rfp_solicitation
  if (cls.documentType === "rfp_solicitation") {
    return {
      documentType: cls.documentType,
      contractStatus: cls.contractStatus,
      classifierConfidence: cls.confidence,
      isRfpSolicitation: true,
      piiRedactedCount: redactionResult.total,
      claimsWritten: 0,
      extractedText: null,
    };
  }

  // 5. Extract claims
  const extracted = await extractClaims(cls.documentType, cls.contractStatus, redactedText);

  // 6. Write claims to DB with status='pending'
  if (extracted.length > 0) {
    await db.insert(claims).values(
      extracted.map((c) => ({
        userId: contract.userId,
        contractId: contract.id,
        fieldPath: c.fieldPath,
        value: c.value,
        snippet: c.snippet,
        confidence: c.confidence,
        status: "pending",
      })),
    );
  }

  return {
    documentType: cls.documentType,
    contractStatus: cls.contractStatus,
    classifierConfidence: cls.confidence,
    isRfpSolicitation: false,
    piiRedactedCount: redactionResult.total,
    claimsWritten: extracted.length,
    extractedText: redactedText,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function extractTextFromFile(buffer: Buffer, filename: string): Promise<string> {
  const name = filename.toLowerCase();
  if (name.endsWith(".pdf")) return extractTextFromPdf(buffer);
  if (name.endsWith(".docx") || name.endsWith(".doc")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return (result.value || "").trim();
  }
  if (name.endsWith(".txt")) return buffer.toString("utf-8").trim();
  throw new Error(`Unsupported file type. Supported: PDF, DOCX, TXT. Got: ${filename}`);
}

function parseJsonOrThrow(raw: string): Record<string, unknown> {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    const lines = cleaned.split("\n");
    if (lines[0].startsWith("```")) lines.shift();
    if (lines.length && lines[lines.length - 1].trim() === "```") lines.pop();
    cleaned = lines.join("\n").trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`LLM returned invalid JSON: ${err}`);
  }
}
