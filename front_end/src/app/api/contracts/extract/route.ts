import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { extractMetadataFromDocument, ExtractionError } from "@/lib/extraction";
import { recordError } from "@/lib/event-log";

export const runtime = "nodejs"; // mupdf requires Node runtime (WASM)
export const maxDuration = 60;

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("document") as File | null;

    if (!file) {
      return NextResponse.json(
        { error: "No document file provided" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await extractMetadataFromDocument(buffer, file.name);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ExtractionError) {
      recordError(user.username, {
        source: "api/contracts/extract",
        code: "EXTRACTION_ERROR",
        message: err.message,
        statusCode: 422,
        severity: "warn",
      });
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("Extraction error:", err);
    recordError(user.username, {
      source: "api/contracts/extract",
      code: err instanceof Error ? err.name : "UNKNOWN",
      message: err instanceof Error ? err.message : String(err),
      statusCode: 500,
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
