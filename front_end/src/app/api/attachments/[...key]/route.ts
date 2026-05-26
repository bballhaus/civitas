// GET /api/attachments/scrapes/v2/attachments/{event_id}/{filename}
//
// Proxy that hands the user a fresh, short-lived presigned URL for an RFP
// attachment we mirrored to S3 during scraping. The scrapers store PDFs
// at `scrapes/v2/attachments/{event_id}/{filename}`; this route generates
// a presigned URL on each request so links in the dashboard never expire
// from the user's perspective — the presigned URL only has to survive
// the redirect (seconds), not the source portal's 20-hour TTL.
//
// Auth: requires a signed-in user via getAuthenticatedUser, matching the
// rest of the dashboard. RFPs themselves are visible to all auth'd users
// today, so attachments follow the same gate.
//
// Path validation: the key must live under `scrapes/v2/attachments/` so
// this route can't be abused to read arbitrary S3 objects (manifests,
// generated docs, etc.).

import { NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getAuthenticatedUser } from "@/lib/auth";
import { getBucket, getS3Client } from "@/lib/s3";

export const runtime = "nodejs";

const ALLOWED_PREFIX = "scrapes/v2/attachments/";
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour — only needs to outlive the redirect

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const auth = await getAuthenticatedUser(request);
  if (!auth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { key: segments } = await params;
  if (!Array.isArray(segments) || segments.length === 0) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  // Reassemble the S3 key from the catch-all segments and validate the
  // prefix. Refuse anything with `..` to keep S3 key normalization sane.
  const key = segments.join("/");
  if (!key.startsWith(ALLOWED_PREFIX) || key.includes("..")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const url = await getSignedUrl(
      getS3Client(),
      new GetObjectCommand({ Bucket: getBucket(), Key: key }),
      { expiresIn: SIGNED_URL_TTL_SECONDS },
    );
    return NextResponse.redirect(url, 302);
  } catch (err) {
    console.error(`[api/attachments] presign failed for key=${key}:`, err);
    return NextResponse.json(
      { error: "Failed to generate download URL" },
      { status: 500 },
    );
  }
}
