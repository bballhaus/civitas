import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  getContract,
  updateContract,
  deleteContract,
} from "@/lib/contract-storage";
import { refreshProfileFromContracts } from "@/lib/profile-storage";
import { config } from "@/lib/config";

const MAX_FILE_SIZE = config.upload.maxFileSize;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".txt"]);

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const contract = await getContract(user.username, id);
  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }
  return NextResponse.json(contract);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;

  try {
    let metadata: Record<string, unknown> = {};
    let fileBuffer: Buffer | undefined;
    let fileName: string | undefined;
    let contentType: string | undefined;

    const ct = request.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("document") as File | null;
      if (file) {
        if (file.size > MAX_FILE_SIZE) {
          return NextResponse.json(
            { error: "File too large. Maximum size is 25 MB." },
            { status: 413 }
          );
        }
        const ext = getFileExtension(file.name);
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          return NextResponse.json(
            { error: "Unsupported file type. Allowed: PDF, DOCX, DOC, TXT." },
            { status: 400 }
          );
        }
        fileBuffer = Buffer.from(await file.arrayBuffer());
        fileName = file.name;
        contentType = file.type || "application/pdf";
      }
      // Parse scalar fields
      for (const key of [
        "title", "rfp_id", "issuing_agency", "jurisdiction_state",
        "jurisdiction_county", "jurisdiction_city", "work_description",
        "contract_value_estimate", "timeline_duration",
      ]) {
        const val = formData.get(key) as string | null;
        if (val !== null) metadata[key] = val;
      }
    } else {
      metadata = await request.json();
    }

    const updated = await updateContract(user.username, id, metadata, fileBuffer, fileName, contentType);
    if (!updated) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }

    await refreshProfileFromContracts(user.username);
    return NextResponse.json(updated);
  } catch (err) {
    console.error("Contract update error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  return PATCH(request, context);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id } = await params;
  const deleted = await deleteContract(user.username, id);
  if (!deleted) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  await refreshProfileFromContracts(user.username);
  return new NextResponse(null, { status: 204 });
}
