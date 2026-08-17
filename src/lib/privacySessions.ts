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

/**
 * The SDK's `localStorage` key prefix: the first six characters of the pool
 * program's base58 id, ahead of the wallet's own pubkey. Written out rather
 * than imported, so this module — deliberately dependency-free, see below —
 * never has to load the SDK to compute it. `scripts/simulate-privacy.mjs`
 * cross-checks this against the real program id.
 */
const POOL_KEY_PREFIX = "9fhQBb";

/**
 * What the SDK caches per wallet in `localStorage`, and what each holds.
 *
 * `tradeHistory` is genuinely sensitive: it is the plaintext indices of the
 * wallet's own commitments in the pool, which is exactly the wallet-to-note
 * linkage a shielded pool exists to hide. It is also, per the SDK's own logic,
 * a display cache of the most recent history and not an input to which notes
 * get spent — so dropping it costs nothing but the history view.
 *
 * `encrypted_outputs` and `fetch_offset` are cheap to lose in a different
 * sense: they are what makes a repeat balance scan fast rather than a ~750,000
 * note, ~25 second walk of the whole pool. Their names embed the wallet's
 * pubkey but their values are ciphertext and an integer.
 */
const PLAINTEXT_LINKAGE_PREFIXES = ["tradeHistory"];
const RESCAN_CACHE_PREFIXES = ["encrypted_outputs", "fetch_offset"];

/**
 * Remove every `localStorage` entry matching `keyPrefixes`, optionally
 * narrowed to one wallet's pubkey. Unscoped is what a blanket "every wallet,
 * on lock" clear needs; scoped is what removing a single wallet needs — it
 * must not force every *other* wallet back into a full pool rescan.
 */
function purge(keyPrefixes: string[], pubkey?: string): void {
  const doomed: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key) continue;
    const matches = keyPrefixes.some((p) => {
      const full = p + POOL_KEY_PREFIX + (pubkey ?? "");
      return key.startsWith(full);
    });
    if (matches) doomed.push(key);
  }
  doomed.forEach((key) => window.localStorage.removeItem(key));
}

/**
 * Called when the vault locks. Drops the derived note key (so it cannot
 * outlive the vault) and the plaintext commitment-index cache — the one piece
 * of Privacy Cash's local storage that is a real confidentiality loss for
 * anyone who reads the app's profile directory without the vault password.
 *
 * The ciphertext caches are left alone here on purpose: purging them on every
 * lock would turn the next balance check back into a full pool scan, which is
 * the kind of cost that teaches people to turn auto-lock off. They are purged
 * only when a wallet actually leaves the vault, in `forgetPrivacyStorage`.
 */
export function forgetPrivacySessions(): void {
  sessions.clear();
  purge(PLAINTEXT_LINKAGE_PREFIXES);
}

/**
 * Called when `pubkey` is removed from the vault. At that point there is no
 * "next balance check" of *that wallet* to keep cheap, so every trace of it —
 * plaintext and ciphertext alike — is dropped rather than left keyed under a
 * pubkey that no longer means anything to this app. Other wallets' caches are
 * untouched.
 */
export function forgetPrivacyStorage(pubkey: string): void {
  purge([...PLAINTEXT_LINKAGE_PREFIXES, ...RESCAN_CACHE_PREFIXES], pubkey);
}

/**
 * The user-facing escape hatch — a "forget everything Privacy Cash has
 * cached" button in Settings, for every wallet still in the vault. Costs a
 * full pool rescan the next time each wallet's balance is checked.
 */
export function forgetAllPrivacyStorage(): void {
  purge([...PLAINTEXT_LINKAGE_PREFIXES, ...RESCAN_CACHE_PREFIXES]);
}
