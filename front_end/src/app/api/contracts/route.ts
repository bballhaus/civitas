import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  listContracts,
  createContract,
} from "@/lib/contract-storage";
import { extractMetadataFromDocument } from "@/lib/extraction";
import { refreshProfileFromContracts } from "@/lib/profile-storage";
import { config } from "@/lib/config";

export const runtime = "nodejs"; // mupdf requires Node runtime (WASM)
export const maxDuration = 60; // LLM extraction can take time

const MAX_FILE_SIZE = config.upload.maxFileSize;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".txt"]);

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

// Magic bytes for file type validation
const FILE_SIGNATURES: Record<string, Buffer> = {
  ".pdf": Buffer.from([0x25, 0x50, 0x44, 0x46]),  // %PDF
  ".docx": Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK (ZIP)
  ".doc": Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),  // OLE compound
};

function validateFileMagicBytes(buffer: Buffer, ext: string): boolean {
  const sig = FILE_SIGNATURES[ext];
  if (!sig) return true; // .txt has no magic bytes
  if (buffer.length < sig.length) return false;
  return buffer.subarray(0, sig.length).equals(sig);
}

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const contracts = await listContracts(user.username);
  return NextResponse.json(contracts, {
    headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=60" },
  });
}

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("document") as File | null;
    const shouldExtract = formData.get("extract") === "true";
    const title = (formData.get("title") as string) || "";

    let metadata: Record<string, unknown> = { title };

    // Parse metadata fields from form data
    for (const key of [
      "rfp_id", "issuing_agency", "jurisdiction_state", "jurisdiction_county",
      "jurisdiction_city", "work_description", "contract_value_estimate",
      "timeline_duration", "contract_type",
    ]) {
      const val = formData.get(key) as string | null;
      if (val) metadata[key] = val;
    }

    // Parse JSON array fields
    for (const key of [
      "required_certifications", "required_clearances", "naics_codes",
      "industry_tags", "work_locations", "technology_stack", "scope_keywords",
      "size_status",
    ]) {
      const val = formData.get(key) as string | null;
      if (val) {
        try {
          metadata[key] = JSON.parse(val);
        } catch {
          metadata[key] = val.split(",").map((s) => s.trim()).filter(Boolean);
        }
      }
    }

    let fileBuffer: Buffer | undefined;
    let fileName: string | undefined;
    let contentType: string | undefined;

    if (file) {
      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File too large. Maximum size is 25 MB.` },
          { status: 413 }
        );
      }

      // Validate file extension
      const ext = getFileExtension(file.name);
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return NextResponse.json(
          { error: `Unsupported file type. Allowed: PDF, DOCX, DOC, TXT.` },
          { status: 400 }
        );
      }

      const arrayBuffer = await file.arrayBuffer();
      fileBuffer = Buffer.from(arrayBuffer);
      fileName = file.name;
      contentType = file.type || "application/pdf";

      // Validate file content matches extension (magic byte check)
      if (!validateFileMagicBytes(fileBuffer, ext)) {
        return NextResponse.json(
          { error: `File content does not match its extension (${ext}). The file may be corrupted or misnamed.` },
          { status: 400 }
        );
      }

      // Extract metadata from document if requested.
      // A parse failure (e.g. corrupt PDF xref) should not block the upload —
      // the file still gets saved with whatever metadata the caller provided.
      if (shouldExtract) {
        try {
          const extracted = await extractMetadataFromDocument(fileBuffer, fileName);
          metadata = {
            ...metadata,
            rfp_id: extracted.rfp_id || metadata.rfp_id,
            issuing_agency: extracted.issuing_agency || metadata.issuing_agency,
            contractor_name: extracted.contractor_name,
            title: metadata.title || extracted.title || "",
            jurisdiction_state: extracted.jurisdiction.state,
            jurisdiction_county: extracted.jurisdiction.county || "",
            jurisdiction_city: extracted.jurisdiction.city || "",
            award_date: extracted.dates.award_date || "",
            start_date: extracted.dates.start_date || "",
            end_date: extracted.dates.end_date || "",
            ...extracted.features,
          };
        } catch (err) {
          console.warn(`[contracts] Extraction failed for ${fileName}, saving without metadata:`, err);
        }
      }
    }

    const contract = await createContract(
      user.username,
      metadata,
      fileBuffer,
      fileName,
      contentType
    );

    if (!contract) {
      return NextResponse.json(
        { error: "Failed to create contract" },
        { status: 500 }
      );
    }

    // Refresh profile after contract creation
    await refreshProfileFromContracts(user.username);

    return NextResponse.json(contract, { status: 201 });
  } catch (err) {
    console.error("Contract create error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
