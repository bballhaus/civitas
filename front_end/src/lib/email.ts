/**
 * Email sending via AWS SES.
 *
 * In sandbox mode, both sender and recipient must be verified in SES.
 * In production mode (after requesting SES production access), only sender needs verification.
 *
 * Setup:
 *   1. Verify sender: aws ses verify-email-identity --email-address your@email.com --region us-east-1
 *   2. Set CIVITAS_FROM_EMAIL env var to the verified email
 *   3. In sandbox: also verify any recipient emails you want to test with
 */
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({ region: process.env.AWS_REGION || "us-east-1" });

const FROM_EMAIL = process.env.CIVITAS_FROM_EMAIL || "";
const isDev = process.env.NODE_ENV === "development";

interface EmailParams {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
}

export async function sendEmail(params: EmailParams): Promise<boolean> {
  // In dev without SES configured, just log
  if (!FROM_EMAIL) {
    console.log(`[Email] No CIVITAS_FROM_EMAIL set. Would send to ${params.to}: ${params.subject}`);
    if (isDev) console.log(`[Email] Body: ${params.textBody}`);
    return true;
  }

  try {
    await ses.send(
      new SendEmailCommand({
        Source: FROM_EMAIL,
        Destination: { ToAddresses: [params.to] },
        Message: {
          Subject: { Data: params.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: params.textBody, Charset: "UTF-8" },
            ...(params.htmlBody
              ? { Html: { Data: params.htmlBody, Charset: "UTF-8" } }
              : {}),
          },
        },
      })
    );
    console.log(`[Email] Sent to ${params.to}: ${params.subject}`);
    return true;
  } catch (err) {
    console.error(`[Email] Failed to send to ${params.to}:`, err);
    return false;
  }
}

export async function sendVerificationEmail(
  email: string,
  username: string,
  token: string,
  host: string,
  proto: string
): Promise<boolean> {
  const verifyUrl = `${proto}://${host}/api/auth/verify-email?token=${token}&username=${encodeURIComponent(username)}`;

  return sendEmail({
    to: email,
    subject: "Verify your Civitas account",
    textBody: `Welcome to Civitas!\n\nPlease verify your email by clicking the link below:\n\n${verifyUrl}\n\nIf you didn't create this account, you can ignore this email.`,
    htmlBody: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">Welcome to Civitas</h2>
        <p>Please verify your email address by clicking the button below:</p>
        <p style="margin: 24px 0;">
          <a href="${verifyUrl}" style="background: #3C89C6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
            Verify Email
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">Or copy this link: ${verifyUrl}</p>
        <p style="color: #999; font-size: 12px;">If you didn't create this account, you can ignore this email.</p>
      </div>
    `,
  });
}

export interface RoundupRfp {
  rfpId: string;
  title: string;
  agency: string | null;
  matchScore: number; // 0-100
  deadline: string | null; // ISO date or null
  detailUrl: string; // absolute URL to /dashboard/rfp/[id]
}

/**
 * Daily morning roundup of unviewed >75% matches.
 *
 * Caller is responsible for filtering — this just renders. If `rfps` is
 * empty the cron skips the send entirely (see /api/cron/daily-roundup),
 * so we don't bother with an empty-state body here.
 */
export async function sendDailyRoundupEmail(
  email: string,
  rfps: RoundupRfp[],
  appOrigin: string,
): Promise<boolean> {
  const subject =
    rfps.length === 1
      ? "1 new RFP match this morning"
      : `${rfps.length} new RFP matches this morning`;

  const textLines = [
    "Your daily Civitas roundup",
    "",
    `${rfps.length} new ${rfps.length === 1 ? "RFP is" : "RFPs are"} above a 75% match and waiting for your first look.`,
    "",
    ...rfps.map((r, i) => {
      const lines = [
        `${i + 1}. ${r.title} — ${Math.round(r.matchScore)}% match`,
      ];
      if (r.agency) lines.push(`   ${r.agency}`);
      if (r.deadline) lines.push(`   Closes ${r.deadline}`);
      lines.push(`   ${r.detailUrl}`);
      return lines.join("\n");
    }),
    "",
    `Open the dashboard: ${appOrigin}/home`,
    "",
    "You're getting this because you opted in at the end of onboarding. Manage notifications in your profile settings.",
  ];

  const htmlRows = rfps
    .map((r) => {
      const meta = [
        r.agency ? `<span style="color:#475569;">${escapeHtml(r.agency)}</span>` : "",
        r.deadline ? `<span style="color:#dc2626;">Closes ${escapeHtml(r.deadline)}</span>` : "",
      ]
        .filter(Boolean)
        .join(" &middot; ");
      return `
        <tr>
          <td style="padding:14px 0; border-bottom:1px solid #e2e8f0;">
            <div style="font-size:15px; font-weight:600; color:#0f172a;">
              <a href="${escapeHtml(r.detailUrl)}" style="color:#3C89C6; text-decoration:none;">${escapeHtml(r.title)}</a>
            </div>
            <div style="font-size:13px; color:#475569; margin-top:4px;">
              <span style="display:inline-block; padding:2px 8px; border-radius:999px; background:#dbeafe; color:#1d4ed8; font-weight:600; font-size:12px;">${Math.round(r.matchScore)}% match</span>
              ${meta ? `&nbsp; ${meta}` : ""}
            </div>
          </td>
        </tr>`;
    })
    .join("");

  return sendEmail({
    to: email,
    subject,
    textBody: textLines.join("\n"),
    htmlBody: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color:#0f172a;">
        <h2 style="color:#1a1a1a; margin-bottom:8px;">Your daily Civitas roundup</h2>
        <p style="color:#475569; margin-top:0;">
          ${rfps.length} new ${rfps.length === 1 ? "RFP is" : "RFPs are"} above a 75% match and waiting for your first look.
        </p>
        <table style="width:100%; border-collapse:collapse; margin-top:16px;">${htmlRows}</table>
        <p style="margin: 24px 0;">
          <a href="${escapeHtml(appOrigin)}/home" style="background:#3C89C6; color:white; padding:12px 20px; border-radius:6px; text-decoration:none; font-weight:600;">
            Open dashboard
          </a>
        </p>
        <p style="color:#94a3b8; font-size:12px;">
          You opted in to this digest at the end of onboarding. Manage notifications in your profile settings.
        </p>
      </div>
    `,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendPasswordResetEmail(
  email: string,
  username: string,
  token: string,
  host: string,
  proto: string
): Promise<boolean> {
  const resetUrl = `${proto}://${host}/reset-password?token=${token}&username=${encodeURIComponent(username)}`;

  return sendEmail({
    to: email,
    subject: "Reset your Civitas password",
    textBody: `A password reset was requested for your Civitas account.\n\nClick the link below to set a new password:\n\n${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, you can ignore this email.`,
    htmlBody: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">Reset Your Password</h2>
        <p>A password reset was requested for your Civitas account.</p>
        <p style="margin: 24px 0;">
          <a href="${resetUrl}" style="background: #3C89C6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
            Reset Password
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">Or copy this link: ${resetUrl}</p>
        <p style="color: #999; font-size: 12px;">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });
}
