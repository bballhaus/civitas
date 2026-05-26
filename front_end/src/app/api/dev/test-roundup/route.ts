// TEMPORARY: preview-only test endpoint to render and send a sample daily
// roundup email. Used to validate the Resend migration end-to-end without
// having to opt a user in + wait until 7am local + accrue matches.
//
// Will be removed before the Resend migration PR merges to main. Guarded
// twice: VERCEL_ENV must be `preview` AND the caller must present the
// cron Bearer secret.

import { NextResponse } from "next/server";
import { sendDailyRoundupEmail, type RoundupRfp } from "@/lib/email";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (process.env.VERCEL_ENV !== "preview" && process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not available in this environment" }, { status: 404 });
  }

  const expected = process.env.CIVITAS_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CIVITAS_CRON_SECRET not set" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const to = url.searchParams.get("to");
  if (!to) {
    return NextResponse.json({ error: "Missing ?to=<email>" }, { status: 400 });
  }

  const origin = process.env.CIVITAS_APP_ORIGIN ?? "https://civitas-ai.net";

  const items: RoundupRfp[] = [
    {
      rfpId: "sample-1",
      title: "IT Managed Services for County Health Department",
      agency: "Alameda County, CA",
      matchScore: 92,
      deadline: "2026-06-12",
      detailUrl: `${origin}/home`,
    },
    {
      rfpId: "sample-2",
      title: "Cybersecurity Assessment Services",
      agency: "City of Sacramento",
      matchScore: 88,
      deadline: "2026-06-05",
      detailUrl: `${origin}/home`,
    },
    {
      rfpId: "sample-3",
      title: "Network Infrastructure Modernization",
      agency: "CalProcure",
      matchScore: 81,
      deadline: "2026-06-20",
      detailUrl: `${origin}/home`,
    },
    {
      rfpId: "sample-4",
      title: "Cloud Migration Advisory Services",
      agency: "San Mateo County",
      matchScore: 76,
      deadline: "2026-06-30",
      detailUrl: `${origin}/home`,
    },
  ];

  const ok = await sendDailyRoundupEmail(to, items, origin);
  return NextResponse.json({ ok, to, count: items.length });
}
