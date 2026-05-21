/**
 * SNS HTTPS subscription message verification.
 * See: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */
import crypto from "node:crypto";

export interface SnsMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: "1" | "2";
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

const certCache = new Map<string, string>();

function isValidSigningCertUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(parsed.hostname)) return false;
  if (!parsed.pathname.endsWith(".pem")) return false;
  return true;
}

async function getCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return cached;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch SNS signing cert (${r.status})`);
  const pem = await r.text();
  certCache.set(url, pem);
  return pem;
}

function buildStringToSign(msg: SnsMessage): string {
  const fields: string[] = [];
  if (msg.Type === "Notification") {
    fields.push("Message", msg.Message, "MessageId", msg.MessageId);
    if (msg.Subject !== undefined) fields.push("Subject", msg.Subject);
    fields.push("Timestamp", msg.Timestamp, "TopicArn", msg.TopicArn, "Type", msg.Type);
  } else {
    if (!msg.SubscribeURL || !msg.Token) return "";
    fields.push(
      "Message", msg.Message,
      "MessageId", msg.MessageId,
      "SubscribeURL", msg.SubscribeURL,
      "Timestamp", msg.Timestamp,
      "Token", msg.Token,
      "TopicArn", msg.TopicArn,
      "Type", msg.Type,
    );
  }
  return fields.join("\n") + "\n";
}

export async function verifySnsMessage(msg: SnsMessage): Promise<boolean> {
  if (msg.SignatureVersion !== "1" && msg.SignatureVersion !== "2") return false;
  if (!isValidSigningCertUrl(msg.SigningCertURL)) return false;
  const stringToSign = buildStringToSign(msg);
  if (!stringToSign) return false;
  const pem = await getCert(msg.SigningCertURL);
  const algo = msg.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256";
  const verifier = crypto.createVerify(algo);
  verifier.update(stringToSign, "utf8");
  return verifier.verify(pem, msg.Signature, "base64");
}
