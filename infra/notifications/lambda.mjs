// AWS Lambda handler for the daily-roundup cron.
//
// EventBridge fires this on the hour. The Lambda's only job is to POST to
// the Next.js cron route, which holds all the real logic (DB queries,
// timezone filtering, match computation, SES send). Keeping the heavy
// lifting in Next.js means we don't have to ship a second copy of the
// matcher + drizzle schema + SES config.
//
// Required env vars (set on the Lambda):
//   CIVITAS_CRON_URL     — full URL to /api/cron/daily-roundup
//                          (e.g. https://app.civitas.example.com/api/cron/daily-roundup)
//   CIVITAS_CRON_SECRET  — must match the same env var on the Next.js host
//
// Node 20.x runtime. Zero npm dependencies — uses built-in fetch.

export const handler = async (event) => {
  const url = process.env.CIVITAS_CRON_URL;
  const secret = process.env.CIVITAS_CRON_SECRET;
  if (!url || !secret) {
    throw new Error(
      "CIVITAS_CRON_URL and CIVITAS_CRON_SECRET must both be set on the Lambda",
    );
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ source: "eventbridge", event }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cron route returned ${res.status}: ${text}`);
  }
  return { statusCode: res.status, body: text };
};
