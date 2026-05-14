// Pending users — signup attempts that have not yet clicked the verification
// link. On verify, the row is promoted into `users` (in a transaction with the
// profile insert) and deleted from `pending_users`.

import { eq, lt } from "drizzle-orm";
import { db } from "../client";
import { pendingUsers, users, profiles, type PendingUser, type User } from "../schema";

export interface UpsertPendingUserInput {
  username: string;
  email: string;
  passwordHash: string;
  verificationToken: string;
  expiresAt: Date;
}

/**
 * Insert or overwrite a pending user row, keyed by email.
 *
 * If someone signs up twice with the same email before verifying, we keep the
 * latest attempt (new token, new password) and discard the old. This avoids
 * stale-token confusion and keeps the table clean.
 */
export async function upsertPendingUser(
  input: UpsertPendingUserInput,
): Promise<PendingUser> {
  return await db.transaction(async (tx) => {
    await tx
      .delete(pendingUsers)
      .where(eq(pendingUsers.email, input.email.toLowerCase()));
    await tx
      .delete(pendingUsers)
      .where(eq(pendingUsers.username, input.username));

    const [row] = await tx
      .insert(pendingUsers)
      .values({
        username: input.username,
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        verificationToken: input.verificationToken,
        expiresAt: input.expiresAt,
      })
      .returning();

    return row;
  });
}

export async function getPendingUserByToken(
  token: string,
): Promise<PendingUser | null> {
  const [row] = await db
    .select()
    .from(pendingUsers)
    .where(eq(pendingUsers.verificationToken, token))
    .limit(1);
  return row ?? null;
}

export async function getPendingUserByEmail(
  email: string,
): Promise<PendingUser | null> {
  const [row] = await db
    .select()
    .from(pendingUsers)
    .where(eq(pendingUsers.email, email.toLowerCase()))
    .limit(1);
  return row ?? null;
}

export async function getPendingUserByUsername(
  username: string,
): Promise<PendingUser | null> {
  const [row] = await db
    .select()
    .from(pendingUsers)
    .where(eq(pendingUsers.username, username))
    .limit(1);
  return row ?? null;
}

/**
 * Promote a pending user to a real user. Runs in a transaction:
 *   - Insert into `users` + empty `profiles`
 *   - Delete the pending row
 *
 * Caller is responsible for validating the token and expiry first.
 */
export async function promotePendingUser(pending: PendingUser): Promise<User> {
  return await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        username: pending.username,
        email: pending.email,
        passwordHash: pending.passwordHash,
        emailVerified: true,
      })
      .returning();

    await tx.insert(profiles).values({ userId: user.id });

    await tx.delete(pendingUsers).where(eq(pendingUsers.id, pending.id));

    return user;
  });
}

/** Delete pending rows past their expiry. Returns count removed. */
export async function deleteExpiredPendingUsers(): Promise<number> {
  const deleted = await db
    .delete(pendingUsers)
    .where(lt(pendingUsers.expiresAt, new Date()))
    .returning({ id: pendingUsers.id });
  return deleted.length;
}
