// POST /api/contracts/v2/ — Architecture-v2 § 6 upload pipeline.
//
// Differs from POST /api/contracts/ (v1) in two important ways:
//   1. Runs the classifier → targeted extractor pipeline (PII redacted) so
//      each extracted fact gets its own row in `claims` with snippet +
//      confidence + status='pending'.
//   2. Does NOT touch profile tables. The user must accept claims on the
//      review screen before anything makes it into specialties /
//      capabilities / licenses / etc. — the hard rule from § 6.5 that
//      keeps re-extraction from silently overwriting user edits.
//
// The v1 endpoint is kept around for the existing /upload page until the
// /contracts review UI fully covers its features.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/db/client";
import { contracts } from "@/db/schema";
import { putObject } from "@/lib/s3";
import { runContractPipeline } from "@/lib/contract-pipeline-v2";
import { recordEvent } from "@/lib/event-log";
import { config } from "@/lib/config";

export const runtime = "nodejs"; // mupdf requires Node runtime (WASM)
export const maxDuration = 90;

const MAX_FILE_SIZE = config.upload.maxFileSize;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".txt"]);

const FILE_SIGNATURES: Record<string, Buffer> = {
  ".pdf": Buffer.from([0x25, 0x50, 0x44, 0x46]),
  ".docx": Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  ".doc": Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
};

function getExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function validMagicBytes(buf: Buffer, ext: string): boolean {
  const sig = FILE_SIGNATURES[ext];
  if (!sig) return true; // .txt
  if (buf.length < sig.length) return false;
  return buf.subarray(0, sig.length).equals(sig);
}

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get("document") as File | null;
  if (!file) {
    return NextResponse.json({ error: "document file is required" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `File too large. Maximum size is ${Math.floor(MAX_FILE_SIZE / 1_048_576)} MB.` },
      { status: 413 },
    );
  }
  const ext = getExt(file.name);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return NextResponse.json(
      { error: "Unsupported file type. Allowed: PDF, DOCX, DOC, TXT." },
      { status: 400 },
    );
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (!validMagicBytes(buf, ext)) {
    return NextResponse.json(
      { error: `File content does not match its extension (${ext}).` },
      { status: 400 },
    );
  }

  // Insert contract row first so we have an id for the S3 key + the claims
  // foreign key. document_type stays 'other' until the classifier returns.
  const [contract] = await db
    .insert(contracts)
    .values({
      userId: user.userId,
      documentType: "other",
      contractStatus: null,
      s3Key: "", // overwritten after upload
      originalFilename: file.name,
      extractedByModel: null,
    })
    .returning();

  const s3Key = `uploads/${user.userId}/${contract.id}/${file.name}`;
  await putObject(s3Key, buf, file.type || "application/octet-stream");

  try {
    const result = await runContractPipeline(contract, buf);

    // Persist classifier + extraction metadata on the contract row.
    await db
      .update(contracts)
      .set({
        documentType: result.documentType,
        contractStatus: result.contractStatus,
        s3Key,
        extractedByModel: "claude-haiku-4-5 + claude-sonnet-4-6",
        extractedAt: new Date(),
        extractedText: result.extractedText,
        textTruncated: !!result.extractedText && result.extractedText.length >= 50_000,
        piiRedactedCount: result.piiRedactedCount,
      })
      .where(eq(contracts.id, contract.id));

    void recordEvent(user.username, "contract_uploaded", {
      contractId: contract.id,
      hasExtraction: !result.isRfpSolicitation,
    });

    if (result.isRfpSolicitation) {
      // Guardrail (spec § 6.4): the user uploaded the agency's RFP itself.
      // Don't extract claims; let the UI redirect to the proposal-generation
      // flow or offer to discard.
      return NextResponse.json(
        {
          contractId: contract.id,
          documentType: "rfp_solicitation",
          isRfpSolicitation: true,
          message:
            "This looks like an RFP solicitation, not a document about your company.",
        },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        contractId: contract.id,
        documentType: result.documentType,
        contractStatus: result.contractStatus,
        classifierConfidence: result.classifierConfidence,
        claimsWritten: result.claimsWritten,
        piiRedactedCount: result.piiRedactedCount,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("[contracts/v2] pipeline error:", err);
    // Keep the contract row so the file isn't orphaned, but mark it 'other'
    // and let the user re-run or delete.
    await db
      .update(contracts)
      .set({ s3Key, extractedByModel: "failed" })
      .where(eq(contracts.id, contract.id));
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Pipeline failed",
        contractId: contract.id,
      },
      { status: 500 },
    );
  }
}
