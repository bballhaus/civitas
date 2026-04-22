import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { extractMetadataFromDocument, ExtractionError } from "@/lib/extraction";

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
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("Extraction error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
