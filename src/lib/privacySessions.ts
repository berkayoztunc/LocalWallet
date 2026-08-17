/**
 * The open Privacy Cash sessions, kept apart from the SDK that creates them.
 *
 * A session holds the key the pool's notes are encrypted under, so locking the
 * vault has to drop it — but the lock button must not drag in six megabytes of
 * proving code to do that. This module has no runtime dependencies at all (the
 * session type is imported for typing only, and erased), which is what lets the
 * dashboard clear the cache without loading the SDK.
 */

import type { PrivacySession } from "./privacyCash";

const sessions = new Map<string, Promise<PrivacySession>>();

export function cachedSession(key: string): Promise<PrivacySession> | undefined {
  return sessions.get(key);
}

export function cacheSession(key: string, session: Promise<PrivacySession>): void {
  sessions.set(key, session);
}

export function dropSession(key: string): void {
  sessions.delete(key);
}

/** Called when the vault locks. The derived note key must not outlive it. */
export function forgetPrivacySessions(): void {
  sessions.clear();
}
