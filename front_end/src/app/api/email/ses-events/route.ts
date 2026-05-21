/**
 * SNS webhook for SES bounce and complaint events.
 * SES Configuration Set "civitas-transactional" publishes BOUNCE/COMPLAINT/REJECT
 * events to SNS topic civitas-ses-events, which posts here.
 *
 * Account-level suppression is handled automatically by SES (Configuration Set
 * SuppressedReasons=BOUNCE,COMPLAINT). This handler only updates our application
 * state: marks the affected user's email_verified=false and logs the event.
 */
import { NextResponse } from "next/server";
import { verifySnsMessage, type SnsMessage } from "@/lib/sns-verify";
import { logSecurityEvent } from "@/lib/security-log";
import { checkEmailUniqueness } from "@/lib/email-index";
import { getUserData, saveUserData } from "@/lib/user-data";

const EXPECTED_TOPIC_ARN =
  process.env.CIVITAS_SES_SNS_TOPIC_ARN ||
  "arn:aws:sns:us-east-1:681816819209:civitas-ses-events";

interface SesBounceNotification {
  notificationType: "Bounce";
  bounce: {
    bounceType: "Permanent" | "Transient" | "Undetermined";
    bounceSubType: string;
    bouncedRecipients: { emailAddress: string; diagnosticCode?: string }[];
    feedbackId: string;
    timestamp: string;
  };
  mail: { messageId: string; source: string };
}

interface SesComplaintNotification {
  notificationType: "Complaint";
  complaint: {
    complainedRecipients: { emailAddress: string }[];
    feedbackId: string;
    complaintFeedbackType?: string;
    timestamp: string;
  };
  mail: { messageId: string; source: string };
}

type SesNotification = SesBounceNotification | SesComplaintNotification;

async function markUserEmailFailed(
  email: string,
  reason: "bounce" | "complaint",
  details: string,
): Promise<void> {
  const username = await checkEmailUniqueness(email);
  if (!username) {
    logSecurityEvent({
      type: reason === "bounce" ? "email_bounce" : "email_complaint",
      details: `no user found for ${email}: ${details}`,
    });
    return;
  }
  const data = await getUserData(username);
  if (!data) return;
  data.email_verified = false;
  await saveUserData(username, data);
  logSecurityEvent({
    type: reason === "bounce" ? "email_bounce" : "email_complaint",
    username,
    details,
  });
}

async function handleNotification(msg: SnsMessage): Promise<void> {
  let event: SesNotification;
  try {
    event = JSON.parse(msg.Message);
  } catch {
    logSecurityEvent({ type: "ses_event_invalid", details: "non-JSON message" });
    return;
  }

  if (event.notificationType === "Bounce") {
    const isHard = event.bounce.bounceType === "Permanent";
    for (const r of event.bounce.bouncedRecipients) {
      if (isHard) {
        await markUserEmailFailed(
          r.emailAddress,
          "bounce",
          `Permanent/${event.bounce.bounceSubType}: ${r.diagnosticCode ?? ""}`.slice(0, 500),
        );
      } else {
        logSecurityEvent({
          type: "email_bounce",
          details: `${event.bounce.bounceType}/${event.bounce.bounceSubType} for ${r.emailAddress} (not actioned)`,
        });
      }
    }
  } else if (event.notificationType === "Complaint") {
    for (const r of event.complaint.complainedRecipients) {
      await markUserEmailFailed(
        r.emailAddress,
        "complaint",
        event.complaint.complaintFeedbackType ?? "unspecified",
      );
    }
  } else {
    logSecurityEvent({
      type: "ses_event_received",
      details: `unhandled notificationType: ${(event as { notificationType?: string }).notificationType ?? "missing"}`,
    });
  }
}

export async function POST(request: Request) {
  let body: SnsMessage;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.TopicArn !== EXPECTED_TOPIC_ARN) {
    logSecurityEvent({
      type: "ses_event_invalid",
      details: `unexpected TopicArn: ${body.TopicArn}`,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let signatureValid = false;
  try {
    signatureValid = await verifySnsMessage(body);
  } catch (err) {
    logSecurityEvent({
      type: "ses_event_invalid",
      details: `signature verification threw: ${(err as Error).message}`,
    });
    return NextResponse.json({ error: "Signature error" }, { status: 400 });
  }
  if (!signatureValid) {
    logSecurityEvent({ type: "ses_event_invalid", details: "bad signature" });
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  if (body.Type === "SubscriptionConfirmation") {
    if (!body.SubscribeURL) {
      return NextResponse.json({ error: "Missing SubscribeURL" }, { status: 400 });
    }
    const r = await fetch(body.SubscribeURL);
    logSecurityEvent({
      type: "ses_event_received",
      details: `SubscriptionConfirmation auto-confirmed (status ${r.status})`,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.Type === "UnsubscribeConfirmation") {
    logSecurityEvent({ type: "ses_event_received", details: "UnsubscribeConfirmation" });
    return NextResponse.json({ ok: true });
  }

  if (body.Type === "Notification") {
    await handleNotification(body);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown Type" }, { status: 400 });
}
