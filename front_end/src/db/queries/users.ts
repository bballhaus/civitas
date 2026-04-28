// User CRUD — the foundation everything else FK's to.
//
// Auth still uses bcrypt + JWT (jose); only the storage layer changes vs. the
// old S3 user-json approach. Password hashing happens in the auth library;
// this file only persists the already-hashed value.

import { eq } from "drizzle-orm";
import { db } from "../client";
import { users, profiles, type User } from "../schema";

export interface CreateUserInput {
  username: string;
  email: string;
  passwordHash: string;
}

/**
 * Create a user and an empty profile in a single transaction.
 *
 * Profile is created up front so every user has a row to update — no
 * "does the profile exist yet?" branching elsewhere in the codebase.
 */
export async function createUser(input: CreateUserInput): Promise<User> {
  return await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        username: input.username,
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
      })
      .returning();

    await tx.insert(profiles).values({ userId: user.id });

    return user;
  });
}

export async function getUserById(id: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

export async function getUserByUsername(username: string): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return user ?? null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return user ?? null;
}

export async function updatePasswordHash(
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function setEmailVerified(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(users.id, userId));
}
