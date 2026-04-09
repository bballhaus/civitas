/**
 * Authentication: JWT signing/verification + password hashing.
 * Replaces Django auth, token_storage.py, and validators.py.
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import bcrypt from "bcryptjs";
import { createHash, pbkdf2 as pbkdf2Callback } from "crypto";
import { promisify } from "util";

const pbkdf2Async = promisify(pbkdf2Callback);

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === "CHANGE_ME_IN_PRODUCTION") {
    throw new Error(
      "JWT_SECRET environment variable must be set to a strong random value."
    );
  }
  return new TextEncoder().encode(secret);
}

const JWT_EXPIRY_DAYS = 7;

// ── JWT ──

export interface AuthPayload extends JWTPayload {
  username: string;
}

export async function signJwt(username: string): Promise<string> {
  return new SignJWT({ username } as AuthPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${JWT_EXPIRY_DAYS}d`)
    .sign(getJwtSecret());
}

export async function verifyJwt(token: string): Promise<AuthPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload as AuthPayload;
  } catch {
    return null;
  }
}

/**
 * Extract and verify the Bearer token from a request's Authorization header.
 * Returns the username if valid, null otherwise.
 */
export async function getAuthenticatedUser(
  request: Request
): Promise<{ username: string } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  const payload = await verifyJwt(token);
  if (!payload?.username) return null;
  return { username: payload.username };
}

// ── Passwords ──

const BCRYPT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Validate password strength. Returns error message or null if valid.
 * Rules: 8+ chars, at least one uppercase, one lowercase, one special character.
 */
export function validatePassword(password: string): string | null {
  if (password.length < 8) {
    return "Password must be at least 8 characters long.";
  }
  if (!/[A-Z]/.test(password)) {
    return "Password must contain at least one uppercase letter.";
  }
  if (!/[a-z]/.test(password)) {
    return "Password must contain at least one lowercase letter.";
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return "Password must contain at least one special character.";
  }
  return null;
}

// ── Django PBKDF2 migration ──

/**
 * Verify a password against a Django PBKDF2 hash.
 * Django format: "pbkdf2_sha256$<iterations>$<salt>$<hash_b64>"
 * Used for transparent migration of existing users.
 */
export async function verifyDjangoPbkdf2(
  password: string,
  djangoHash: string
): Promise<boolean> {
  try {
    const parts = djangoHash.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
    const iterations = parseInt(parts[1], 10);
    const salt = parts[2];
    const storedHash = parts[3];

    const derived = await pbkdf2Async(
      password,
      salt,
      iterations,
      32,
      "sha256"
    );
    const derivedB64 = derived.toString("base64");
    return derivedB64 === storedHash;
  } catch {
    return false;
  }
}
