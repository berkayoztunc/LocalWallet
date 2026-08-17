/**
 * Privacy Cash — private SOL transfers through a shielded pool.
 *
 * Depositing hands SOL to a pool contract and records an encrypted note only
 * the depositor can read. Withdrawing proves, in zero knowledge, that some
 * unspent note exists without saying which one, so the address that receives
 * the withdrawal cannot be tied back to the address that deposited. A private
 * send is therefore a deposit followed later by a withdrawal to someone else,
 * and "unshielding" is the same withdrawal aimed back at your own wallet.
 *
 * The proving work only exists as JavaScript and WASM, so it runs here rather
 * than in the Rust backend. That does not mean keys come with it: this module
 * drives the SDK's lower-level entry points, which accept an external signer,
 * and every signature is fetched from the backend over the `privacy_sign_*`
 * commands. No secret key is ever read into the webview.
 *
 * Two consequences worth knowing:
 *
 * * Notes are encrypted under a key stretched from a signature over a fixed
 *   message, which is what the Privacy Cash web app uses too — the same wallet
 *   sees the same private balance in either.
 * * A withdrawal is submitted by Privacy Cash's relayer, not by this app, and
 *   the relayer takes a fee. It never holds the funds, but it does see the
 *   recipient. Deposits go out through the configured RPC like any other
 *   transaction.
 */

import { invoke } from "@tauri-apps/api/core";
import { WasmFactory } from "@lightprotocol/hasher.rs";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  EncryptionService,
  deposit,
  getBalanceFromUtxos,
  getConfig,
  getUtxos,
  setLogger,
  withdraw,
} from "privacycash/utils";

import { LAMPORTS_PER_SOL } from "./api";
import { cacheSession, cachedSession, dropSession } from "./privacySessions";

/**
 * The message the backend will sign to derive the note encryption key. It has
 * to match `privacy::SIGN_IN_MESSAGE` and the Privacy Cash web app exactly:
 * a different message derives a different key, which would hide any balance
 * already deposited.
 */
const SIGN_IN_MESSAGE = "Privacy Money account sign in";

/**
 * Where the proving key and circuit live. Served from the app bundle by the
 * `privacy-cash-assets` plugin in `vite.config.ts` rather than committed —
 * they are 19 MB of build output the SDK already ships.
 */
const CIRCUIT_BASE_PATH = "/circuit2/transaction2";

/** An unlocked wallet's view of the pool. Building one asks for a signature. */
export interface PrivacySession {
  pubkey: string;
  publicKey: PublicKey;
  connection: Connection;
  encryptionService: EncryptionService;
  storage: Storage;
}

export interface PrivateBalance {
  lamports: number;
}

/** What a shield or private send will actually cost, priced before sending. */
export interface PrivacyQuote {
  /** What leaves the source (shield) or the pool (send). */
  amount: number;
  /** Privacy Cash's cut. Zero for a shield — deposits pay no protocol fee. */
  fee: number;
  /** What the recipient ends up with. */
  net: number;
  /** Smallest amount the relayer will process, when it applies. */
  minimum: number | null;
}

export interface PrivateSendResult {
  signature: string;
  recipient: string;
  amount: number;
  fee: number;
  /** The pool held less than was asked for and sent what it had. */
  partial: boolean;
}

/**
 * Open (or reuse) the pool session for `pubkey`.
 *
 * Sessions are cached because opening one costs a signature and a key
 * derivation, and every panel in the dialog needs the same one. The cache
 * itself lives in `privacySessions` so that locking the vault can clear it
 * without loading this module.
 *
 * The signature this asks the backend for is deterministic, so re-deriving it
 * later always reproduces the same encryption key and the same balance.
 */
export function openPrivacySession(pubkey: string, rpcUrl: string): Promise<PrivacySession> {
  const cacheKey = `${pubkey}@${rpcUrl}`;
  const existing = cachedSession(cacheKey);
  if (existing) return existing;

  const opening = (async () => {
    const message = new TextEncoder().encode(SIGN_IN_MESSAGE);
    const signature = await invoke<number[]>("privacy_sign_in", {
      pubkey,
      message: Array.from(message),
    });

    const encryptionService = new EncryptionService();
    encryptionService.deriveEncryptionKeyFromSignature(new Uint8Array(signature));

    return {
      pubkey,
      publicKey: new PublicKey(pubkey),
      connection: new Connection(rpcUrl, "confirmed"),
      encryptionService,
      storage: window.localStorage,
    } satisfies PrivacySession;
  })();

  // A failed open must not be cached, or the wallet is stuck until relaunch.
  opening.catch(() => dropSession(cacheKey));
  cacheSession(cacheKey, opening);
  return opening;
}

/**
 * Read a wallet's shielded balance.
 *
 * This is expensive, and worth understanding before calling it anywhere it
 * could surprise someone. Which notes are yours is not something the pool
 * records — the only way to find out is to fetch every note in it and try to
 * decrypt each one with your key. That is currently about 750,000 notes and
 * 130 MB, and it has to happen once per wallet, because each wallet has a
 * different key. Measured at roughly 25 seconds over a fast connection outside
 * the app; slower in a webview, and it grows with the pool.
 *
 * That cost is why there is no bulk version: scanning N wallets means N passes
 * over the whole pool. Afterwards the SDK caches a resume offset per wallet, so
 * later reads only cover notes added since. `onStatus` exists because even one
 * pass runs long enough that a silent spinner reads as a hang.
 */
export async function privateBalance(
  session: PrivacySession,
  options: { abortSignal?: AbortSignal; onStatus?: (message: string) => void } = {},
): Promise<PrivateBalance> {
  return withScanLock(async () => {
    // The SDK's logger is module-global, so it is set per call and cleared
    // after — the same reason scans are serialized in the first place.
    if (options.onStatus) {
      setLogger((level, message) => {
        if (level === "info") options.onStatus?.(message);
      });
    }
    try {
      const utxos = await getUtxos({
        publicKey: session.publicKey,
        connection: session.connection,
        encryptionService: session.encryptionService,
        storage: session.storage,
        abortSignal: options.abortSignal,
      });
      return getBalanceFromUtxos(utxos);
    } finally {
      setLogger(() => {});
    }
  });
}

/**
 * Serialize everything that walks the note set.
 *
 * `getUtxos` tracks its paging position in module-level variables, so two
 * concurrent calls interleave and corrupt each other's results — a wallet
 * would report someone else's balance, or none. Queueing is not a performance
 * choice here; overlapping scans are simply wrong.
 */
let scanQueue: Promise<unknown> = Promise.resolve();

function withScanLock<T>(work: () => Promise<T>): Promise<T> {
  const next = scanQueue.then(work, work);
  // Keep the chain alive regardless of how this link settles.
  scanQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Price a shield. Deposits pay no protocol fee — only the network fee, which
 * the depositing wallet covers on top like any other transaction.
 */
export function quoteShield(lamports: number): PrivacyQuote {
  return { amount: lamports, fee: 0, net: lamports, minimum: null };
}

/**
 * Price a withdrawal, using the same formula the SDK applies when it builds
 * one: a percentage of the amount plus a flat rent charge.
 */
export async function quotePrivateSend(lamports: number): Promise<PrivacyQuote> {
  const [rate, rentFee, minimums] = await Promise.all([
    getConfig("withdraw_fee_rate"),
    getConfig("withdraw_rent_fee"),
    getConfig("minimum_withdrawal"),
  ]);
  const fee = Math.floor(lamports * rate + LAMPORTS_PER_SOL * rentFee);
  // The relayer keys its per-token limits in lowercase.
  const minimum = minimums?.sol != null ? Math.round(minimums.sol * LAMPORTS_PER_SOL) : null;
  return { amount: lamports, fee, net: Math.max(0, lamports - fee), minimum };
}

/**
 * Move SOL from `session`'s wallet into the pool.
 *
 * The SDK builds the transaction and hands it back through `transactionSigner`
 * for a signature; that call is the only thing that touches the vault, and it
 * gets bytes rather than a key.
 */
export async function shield(session: PrivacySession, lamports: number): Promise<string> {
  const lightWasm = await WasmFactory.getInstance();

  // Deposits read the note set to find inputs, so they contend with balance
  // scans over the same module-level paging state.
  const result = await withScanLock(() =>
    deposit({
      lightWasm,
      amount_in_lamports: lamports,
      connection: session.connection,
      encryptionService: session.encryptionService,
      publicKey: session.publicKey,
      keyBasePath: CIRCUIT_BASE_PATH,
      storage: session.storage,
      transactionSigner: async (tx: VersionedTransaction) => {
        const signed = await invoke<number[]>("privacy_sign_transaction", {
          pubkey: session.pubkey,
          transaction: Array.from(tx.serialize()),
        });
        return VersionedTransaction.deserialize(new Uint8Array(signed));
      },
    }),
  );

  return result.tx;
}

/**
 * Send SOL out of the pool to `recipient`.
 *
 * No signature is involved: the pool authorizes this with the zero-knowledge
 * proof generated below, which is exactly what leaves the recipient unlinked
 * from whoever deposited. Pointing `recipient` at one of your own wallets is
 * the same operation, and is how funds come back out.
 */
export async function privateSend(
  session: PrivacySession,
  lamports: number,
  recipient: string,
): Promise<PrivateSendResult> {
  const lightWasm = await WasmFactory.getInstance();

  // Withdrawals pick their inputs from the note set too.
  const result = await withScanLock(() =>
    withdraw({
      lightWasm,
      amount_in_lamports: lamports,
      connection: session.connection,
      encryptionService: session.encryptionService,
      publicKey: session.publicKey,
      recipient: new PublicKey(recipient),
      keyBasePath: CIRCUIT_BASE_PATH,
      storage: session.storage,
    }),
  );

  return {
    signature: result.tx,
    recipient: result.recipient,
    amount: result.amount_in_lamports,
    fee: result.fee_in_lamports,
    partial: result.isPartial,
  };
}
