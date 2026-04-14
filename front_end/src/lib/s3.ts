/**
 * S3 client utility.
 * Replaces back_end/contracts/services/aws_client.py and S3 operations from user_data_s3.py.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

function getRegionValue(): string {
  return process.env.AWS_REGION || "us-east-1";
}

function getBucketValue(): string {
  return process.env.AWS_S3_BUCKET || "civitas-ai";
}

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: getRegionValue(),
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
  }
  return _client;
}

export function getBucket(): string {
  return getBucketValue();
}

export function getRegion(): string {
  return getRegionValue();
}

export async function getObject(key: string): Promise<string | null> {
  try {
    const resp = await getClient().send(
      new GetObjectCommand({ Bucket: getBucketValue(), Key: key })
    );
    return (await resp.Body?.transformToString("utf-8")) ?? null;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.name === "NoSuchKey" || err.name === "NotFound")
    ) {
      return null;
    }
    console.warn(`S3 getObject failed for key=${key}:`, err);
    return null;
  }
}

export async function getObjectJSON<T = Record<string, unknown>>(
  key: string
): Promise<T | null> {
  const body = await getObject(key);
  if (body === null) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    console.warn(`S3 JSON parse failed for key=${key}`);
    return null;
  }
}

export async function putObject(
  key: string,
  body: string | Buffer,
  contentType = "application/json"
): Promise<boolean> {
  try {
    await getClient().send(
      new PutObjectCommand({ Bucket: getBucketValue(), Key: key, Body: body, ContentType: contentType })
    );
    return true;
  } catch (err) {
    console.warn(`S3 putObject failed for key=${key}:`, err);
    return false;
  }
}

export async function putObjectJSON(
  key: string,
  data: unknown
): Promise<boolean> {
  return putObject(key, JSON.stringify(data), "application/json");
}

export async function deleteObject(key: string): Promise<boolean> {
  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: getBucketValue(), Key: key })
    );
    return true;
  } catch (err) {
    console.warn(`S3 deleteObject failed for key=${key}:`, err);
    return false;
  }
}

export async function uploadFile(
  key: string,
  buffer: Buffer,
  contentType = "application/pdf"
): Promise<boolean> {
  return putObject(key, buffer, contentType);
}

export async function listObjects(
  prefix: string
): Promise<string[]> {
  try {
    const resp = await getClient().send(
      new ListObjectsV2Command({ Bucket: getBucketValue(), Prefix: prefix })
    );
    return (resp.Contents ?? []).map((obj) => obj.Key!).filter(Boolean);
  } catch (err) {
    console.warn(`S3 listObjects failed for prefix=${prefix}:`, err);
    return [];
  }
}

export function getDocumentUrl(s3Key: string): string {
  const bucket = getBucketValue();
  if (!s3Key || !bucket) return "";
  return `https://${bucket}.s3.${getRegionValue()}.amazonaws.com/${s3Key}`;
}
