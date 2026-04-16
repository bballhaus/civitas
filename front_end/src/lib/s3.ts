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
import { config } from "./config";

let _client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!_client) {
    // Use default credential provider chain (env vars, IAM roles, instance metadata).
    // Works on Vercel (env vars) and Lambda (IAM role) without hardcoding credentials.
    _client = new S3Client({ region: config.aws.region });
  }
  return _client;
}

export function getBucket(): string {
  return config.aws.s3Bucket;
}

export function getRegion(): string {
  return config.aws.region;
}

export async function getObject(key: string): Promise<string | null> {
  try {
    const resp = await getS3Client().send(
      new GetObjectCommand({ Bucket: config.aws.s3Bucket, Key: key })
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
    await getS3Client().send(
      new PutObjectCommand({ Bucket: config.aws.s3Bucket, Key: key, Body: body, ContentType: contentType })
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
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: config.aws.s3Bucket, Key: key })
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
    const resp = await getS3Client().send(
      new ListObjectsV2Command({ Bucket: config.aws.s3Bucket, Prefix: prefix })
    );
    return (resp.Contents ?? []).map((obj) => obj.Key!).filter(Boolean);
  } catch (err) {
    console.warn(`S3 listObjects failed for prefix=${prefix}:`, err);
    return [];
  }
}

export function getDocumentUrl(s3Key: string): string {
  const bucket = config.aws.s3Bucket;
  if (!s3Key || !bucket) return "";
  return `https://${bucket}.s3.${config.aws.region}.amazonaws.com/${s3Key}`;
}

// ── ETag-based optimistic locking ──

export interface ObjectWithETag<T> {
  data: T;
  etag: string | null;
}

export async function getObjectJSONWithETag<T = Record<string, unknown>>(
  key: string
): Promise<ObjectWithETag<T> | null> {
  try {
    const resp = await getS3Client().send(
      new GetObjectCommand({ Bucket: getBucket(), Key: key })
    );
    const body = await resp.Body?.transformToString("utf-8");
    if (!body) return null;
    return { data: JSON.parse(body) as T, etag: resp.ETag ?? null };
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === "NoSuchKey" || err.name === "NotFound")) {
      return null;
    }
    console.warn(`S3 getObjectJSONWithETag failed for key=${key}:`, err);
    return null;
  }
}

export async function putObjectJSONIfMatch(
  key: string,
  data: unknown,
  etag: string | null
): Promise<boolean> {
  try {
    const params: Record<string, unknown> = {
      Bucket: getBucket(),
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    };
    if (etag) {
      (params as Record<string, string>).IfMatch = etag;
    }
    await getS3Client().send(new PutObjectCommand(params as any));
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === "PreconditionFailed" || err.name === "412")) {
      console.warn(`S3 ETag conflict for key=${key} — data was modified by another request`);
      return false;
    }
    console.warn(`S3 putObjectJSONIfMatch failed for key=${key}:`, err);
    return false;
  }
}
