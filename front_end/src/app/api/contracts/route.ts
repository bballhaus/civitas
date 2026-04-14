import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  listContracts,
  createContract,
} from "@/lib/contract-storage";
import { extractMetadataFromDocument } from "@/lib/extraction";
import { refreshProfileFromContracts } from "@/lib/profile-storage";

export const maxDuration = 60; // LLM extraction can take time

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".txt"]);

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
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

      // Extract metadata from document if requested
      if (shouldExtract) {
        const extracted = await extractMetadataFromDocument(fileBuffer, fileName);
        // Flatten extraction result into metadata
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
