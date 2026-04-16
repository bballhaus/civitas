/**
 * Centralized configuration loader.
 * Reads civitas.config.json for operational settings and env vars for secrets.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

interface CivitasConfig {
  llm: {
    provider: string;
    model: string;
    extraction: { model: string; maxChars: number };
    proposal: { maxContextChars: number };
  };
  auth: { jwtExpiryDays: number; bcryptRounds: number };
  rateLimit: {
    auth: { limit: number; windowMs: number };
    extract: { limit: number; windowMs: number };
    cleanupIntervalMs: number;
  };
  cache: { userDataTtlMs: number; s3TtlMs: number };
  upload: { maxFileSize: number; maxFiles: number };
}

function loadConfigFile(): CivitasConfig {
  // Walk up from front_end/src/lib/ to find civitas.config.json at project root
  const paths = [
    resolve(process.cwd(), "civitas.config.json"),
    resolve(process.cwd(), "../civitas.config.json"),
  ];
  for (const p of paths) {
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as CivitasConfig;
    } catch {
      // try next path
    }
  }
  // Return defaults if file not found (should not happen in production)
  return {
    llm: {
      provider: "groq",
      model: "llama-3.1-8b-instant",
      extraction: { model: "llama-3.1-8b-instant", maxChars: 50000 },
      proposal: { maxContextChars: 80000 },
    },
    auth: { jwtExpiryDays: 7, bcryptRounds: 12 },
    rateLimit: {
      auth: { limit: 10, windowMs: 60000 },
      extract: { limit: 5, windowMs: 60000 },
      cleanupIntervalMs: 300000,
    },
    cache: { userDataTtlMs: 10000, s3TtlMs: 300000 },
    upload: { maxFileSize: 26214400, maxFiles: 10 },
  };
}

const file = loadConfigFile();

export const config = {
  llm: {
    provider: file.llm.provider as "groq" | "openai" | "anthropic",
    model: file.llm.model,
    extraction: file.llm.extraction,
    proposal: file.llm.proposal,
    groqApiKey: process.env.GROQ_API_KEY || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  },
  aws: {
    region: process.env.AWS_REGION || "us-east-1",
    s3Bucket: process.env.AWS_S3_BUCKET || "civitas-ai",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
  auth: file.auth,
  rateLimit: file.rateLimit,
  cache: file.cache,
  upload: file.upload,
} as const;
