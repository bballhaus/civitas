// One-off migration: lowercase all S3-stored username paths so logins are
// case-insensitive end-to-end. Companion to the signup/login/reset
// normalization in src/app/api/auth/*/route.ts.
//
// What it does, per mixed-case username `Brooke`:
//   1. users/Brooke.json          → users/brooke.json
//   2. uploads/Brooke/**          → uploads/brooke/**   (skipped when the
//                                                       user has legacy_user_id,
//                                                       since uploads then live
//                                                       under uploads/{numeric_id})
//   3. system/email-index.json    → values rewritten to the lowercased username
//
// Fails loudly on collision (both Brooke.json and brooke.json exist) — you must
// resolve those by hand.
//
// Usage (from front_end/):
//   AWS_REGION=us-east-1 AWS_S3_BUCKET=civitas-ai \
//   node scripts/migrate-usernames-lowercase.cjs --dry-run
//
//   …then re-run with --apply to actually mutate S3.

const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} = require("@aws-sdk/client-s3");

const REGION = process.env.AWS_REGION || "us-east-1";
const BUCKET = process.env.AWS_S3_BUCKET || "civitas-ai";
const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

const USERS_PREFIX = "users/";
const UPLOADS_PREFIX = "uploads/";
const EMAIL_INDEX_KEY = "system/email-index.json";

const s3 = new S3Client({ region: REGION });

function log(...args) {
  console.log(DRY_RUN ? "[dry-run]" : "[apply]", ...args);
}

async function listAll(prefix) {
  const keys = [];
  let token = undefined;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })
    );
    for (const obj of resp.Contents || []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function readJson(key) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = await resp.Body.transformToString("utf-8");
  return JSON.parse(body);
}

async function writeJson(key, data) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    })
  );
}

async function copyObject(srcKey, destKey) {
  await s3.send(
    new CopyObjectCommand({
      Bucket: BUCKET,
      Key: destKey,
      CopySource: `/${BUCKET}/${encodeURIComponent(srcKey).replace(/%2F/g, "/")}`,
    })
  );
}

async function deleteKey(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function keyExists(key) {
  // ListObjectsV2 with the exact key as a prefix returns a Contents entry only if the key exists.
  const resp = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: key, MaxKeys: 1 })
  );
  return (resp.Contents || []).some((o) => o.Key === key);
}

function parseUsernameFromUserKey(key) {
  // key shape: users/<encodeURIComponent(username)>.json
  const stripped = key.slice(USERS_PREFIX.length);
  if (!stripped.endsWith(".json")) return null;
  const encoded = stripped.slice(0, -".json".length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function userKeyFor(username) {
  return `${USERS_PREFIX}${encodeURIComponent(username)}.json`;
}

function uploadsPrefixFor(username) {
  return `${UPLOADS_PREFIX}${encodeURIComponent(username)}/`;
}

async function migrateUserJson(originalUsername) {
  const lower = originalUsername.toLowerCase();
  const srcKey = userKeyFor(originalUsername);
  const destKey = userKeyFor(lower);

  if (await keyExists(destKey)) {
    throw new Error(
      `COLLISION: both ${srcKey} and ${destKey} exist. Resolve manually before re-running.`
    );
  }

  log(`user file: ${srcKey} → ${destKey}`);
  if (APPLY) {
    await copyObject(srcKey, destKey);
    await deleteKey(srcKey);
  }
  return { srcKey, destKey };
}

async function migrateUploads(originalUsername, userData) {
  if (userData && userData.legacy_user_id) {
    // Uploads live under uploads/{legacy_user_id}/... — nothing to rename.
    return 0;
  }
  const lower = originalUsername.toLowerCase();
  const srcPrefix = uploadsPrefixFor(originalUsername);
  const destPrefix = uploadsPrefixFor(lower);

  const keys = await listAll(srcPrefix);
  if (keys.length === 0) return 0;

  log(`uploads: ${keys.length} object(s) under ${srcPrefix} → ${destPrefix}`);
  for (const srcKey of keys) {
    const destKey = destPrefix + srcKey.slice(srcPrefix.length);
    log(`  ${srcKey} → ${destKey}`);
    if (APPLY) {
      await copyObject(srcKey, destKey);
      await deleteKey(srcKey);
    }
  }
  return keys.length;
}

async function migrateEmailIndex(renamed) {
  // renamed: Map<originalUsername, lowercasedUsername>
  let index;
  try {
    index = await readJson(EMAIL_INDEX_KEY);
  } catch (err) {
    if (err && err.name === "NoSuchKey") {
      log(`no email-index found at ${EMAIL_INDEX_KEY}, skipping`);
      return;
    }
    throw err;
  }

  let changes = 0;
  for (const [email, username] of Object.entries(index)) {
    if (renamed.has(username)) {
      const lowered = renamed.get(username);
      log(`email-index: ${email}: "${username}" → "${lowered}"`);
      index[email] = lowered;
      changes += 1;
    }
  }

  if (changes === 0) {
    log(`email-index: no entries needed rewriting`);
    return;
  }
  if (APPLY) {
    await writeJson(EMAIL_INDEX_KEY, index);
  }
  log(`email-index: ${changes} entr${changes === 1 ? "y" : "ies"} rewritten`);
}

async function main() {
  console.log(`Bucket:   ${BUCKET}`);
  console.log(`Region:   ${REGION}`);
  console.log(`Mode:     ${APPLY ? "APPLY (will mutate S3)" : "dry-run"}`);
  console.log("");

  const userKeys = await listAll(USERS_PREFIX);
  const candidates = [];
  for (const key of userKeys) {
    const username = parseUsernameFromUserKey(key);
    if (!username) continue;
    if (username === username.toLowerCase()) continue;
    candidates.push({ key, username });
  }

  if (candidates.length === 0) {
    console.log("No mixed-case usernames found — nothing to do.");
    return;
  }

  console.log(`Found ${candidates.length} mixed-case user file(s):`);
  for (const c of candidates) {
    console.log(`  ${c.key}  (username="${c.username}")`);
  }
  console.log("");

  const renamed = new Map();
  for (const { username } of candidates) {
    // Read user data BEFORE renaming so we know whether legacy_user_id is set.
    let userData = null;
    try {
      userData = await readJson(userKeyFor(username));
    } catch (err) {
      console.warn(`  could not read ${userKeyFor(username)}:`, err.message);
    }

    await migrateUserJson(username);
    await migrateUploads(username, userData);
    renamed.set(username, username.toLowerCase());
  }

  await migrateEmailIndex(renamed);

  console.log("");
  if (DRY_RUN) {
    console.log("Dry-run complete. Re-run with --apply to execute.");
  } else {
    console.log("Migration complete.");
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
