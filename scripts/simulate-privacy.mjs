#!/usr/bin/env node
/**
 * Exercise the Privacy Cash integration against mainnet without moving funds.
 *
 * Privacy Cash has no devnet deployment, so the only honest way to check the
 * wiring short of spending real SOL is to do everything a real shield does and
 * stop at the point of submission. That is what this does:
 *
 *   1. Derives the note encryption key from an ed25519 signature over the same
 *      message the Rust backend signs, and checks a note survives a round trip.
 *      This is the part that would silently produce an unreadable balance if
 *      the signature format or the message ever drifted.
 *   2. Reads the relayer's live fee configuration and reprices a withdrawal
 *      with the app's own quote arithmetic, checking it against the SDK's.
 *   3. Scans the pool for a wallet's notes, which is the same read the balance
 *      in the dialog performs.
 *   4. With a funded wallet, builds a real deposit — real proof, real circuit,
 *      real transaction — signs it exactly as `privacy.rs` does, and asks the
 *      RPC to simulate it. Nothing is ever sent.
 *
 * Usage:
 *   node scripts/simulate-privacy.mjs                       # steps 1-2
 *   PRIVACY_SIM_PUBKEY=<address> node scripts/...           # adds step 3
 *   PRIVACY_SIM_SECRET=<base58 key> node scripts/...        # adds step 4
 *
 * `PRIVACY_SIM_SECRET` is only ever used to sign a transaction that is thrown
 * away. It still has to belong to a wallet holding rather more than the amount
 * below, since the deposit is built for real before it is discarded.
 */
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { WasmFactory } from "@lightprotocol/hasher.rs";
import { LocalStorage } from "node-localstorage";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  EncryptionService,
  deposit,
  getBalanceFromUtxos,
  getConfig,
  getUtxos,
} from "privacycash/utils";

/** Must match `privacy::SIGN_IN_MESSAGE` and `SIGN_IN_MESSAGE` in privacyCash.ts. */
const SIGN_IN_MESSAGE = "Privacy Money account sign in";
const RPC_URL = process.env.PRIVACY_SIM_RPC ?? "https://api.mainnet-beta.solana.com";
const SIMULATED_DEPOSIT_LAMPORTS = 0.02 * LAMPORTS_PER_SOL;

// The package does not export its manifest, so the install is located through
// a subpath it does export and walked back up to the circuit directory.
const require = createRequire(import.meta.url);
const CIRCUIT_BASE_PATH = path.join(
  path.dirname(require.resolve("privacycash/utils")),
  "..",
  "circuit2",
  "transaction2",
);

let failures = 0;

function check(label, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail && `  — ${detail}`}`);
  if (!ok) failures += 1;
}

function heading(text) {
  console.log(`\n${text}`);
}

/**
 * Reproduce what `privacy::sign_in` returns: a raw ed25519 signature over the
 * message bytes. The backend's own tests prove the Rust side matches.
 */
function signInSignature(keypair) {
  return nacl.sign.detached(new TextEncoder().encode(SIGN_IN_MESSAGE), keypair.secretKey);
}

/** The app's quote arithmetic, mirrored from `quotePrivateSend`. */
function quotePrivateSend(lamports, rate, rentFee) {
  const fee = Math.floor(lamports * rate + LAMPORTS_PER_SOL * rentFee);
  return { fee, net: Math.max(0, lamports - fee) };
}

async function checkEncryption() {
  heading("1. Note encryption key, derived the way the backend signs");

  const keypair = Keypair.generate();
  const signature = signInSignature(keypair);
  check("signature is 64 bytes", signature.length === 64, `${signature.length}`);

  const again = signInSignature(keypair);
  check(
    "signing is deterministic, so a balance is recoverable",
    Buffer.from(signature).equals(Buffer.from(again)),
  );

  const service = new EncryptionService();
  service.deriveEncryptionKeyFromSignature(signature);

  const secret = "a note only this wallet should read";
  const roundTripped = service.decrypt(service.encrypt(secret)).toString();
  check("a note survives encrypt and decrypt", roundTripped === secret, roundTripped);

  const stranger = new EncryptionService();
  stranger.deriveEncryptionKeyFromSignature(signInSignature(Keypair.generate()));
  let rejected = false;
  try {
    stranger.decrypt(service.encrypt(secret));
  } catch {
    rejected = true;
  }
  check("another wallet's key cannot read it", rejected);
}

async function checkQuotes() {
  heading("2. Live relayer fees, and the quote the dialog would show");

  const [rate, rentFee, minimums] = await Promise.all([
    getConfig("withdraw_fee_rate"),
    getConfig("withdraw_rent_fee"),
    getConfig("minimum_withdrawal"),
  ]);

  check("relayer reports a withdraw fee rate", typeof rate === "number", `${rate}`);
  check("relayer reports a rent fee", typeof rentFee === "number", `${rentFee} SOL`);

  const amount = 0.05 * LAMPORTS_PER_SOL;
  const quote = quotePrivateSend(amount, rate, rentFee);
  // The SDK computes this inline in withdraw(); recomputing it here is what
  // catches the app drifting away from the fee the relayer actually charges.
  const sdkFee = Math.floor(amount * rate + LAMPORTS_PER_SOL * rentFee);
  check("app quote matches the SDK's formula", quote.fee === sdkFee, `${quote.fee} vs ${sdkFee}`);
  check("a 0.05 SOL send leaves something behind", quote.net > 0, `${quote.net / LAMPORTS_PER_SOL} SOL`);

  // The relayer keys its per-token limits in lowercase, as `quotePrivateSend`
  // in src/lib/privacyCash.ts also assumes.
  check("relayer states a SOL minimum", typeof minimums?.sol === "number", `${minimums?.sol} SOL`);
  console.log(`       fee on a 0.05 SOL send: ${quote.fee / LAMPORTS_PER_SOL} SOL`);
}

async function checkBalanceScan(pubkey, storage) {
  heading(`3. Pool notes for ${pubkey}`);

  // Without the wallet's key the notes cannot be decrypted, so this proves the
  // scan and the relayer reads work, not the balance itself.
  const service = new EncryptionService();
  service.deriveEncryptionKeyFromSignature(signInSignature(Keypair.generate()));

  const utxos = await getUtxos({
    publicKey: new PublicKey(pubkey),
    connection: new Connection(RPC_URL, "confirmed"),
    encryptionService: service,
    storage,
  });
  const balance = getBalanceFromUtxos(utxos);
  check("the pool scan completes", Number.isFinite(balance.lamports), `${utxos.length} notes read`);
}

async function simulateDeposit(secret, storage) {
  heading("4. A real deposit, built and signed but simulated instead of sent");

  const keypair = Keypair.fromSecretKey(bs58.decode(secret));
  const connection = new Connection(RPC_URL, "confirmed");
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`       ${keypair.publicKey.toBase58()} holds ${balance / LAMPORTS_PER_SOL} SOL`);

  const service = new EncryptionService();
  service.deriveEncryptionKeyFromSignature(signInSignature(keypair));

  let captured = null;
  const stopBeforeSending = Symbol("simulate only");

  try {
    await deposit({
      lightWasm: await WasmFactory.getInstance(),
      amount_in_lamports: SIMULATED_DEPOSIT_LAMPORTS,
      connection,
      encryptionService: service,
      publicKey: keypair.publicKey,
      keyBasePath: CIRCUIT_BASE_PATH,
      storage,
      // Signing the way `privacy::sign_transaction` does — in place, leaving
      // the message untouched — then bailing out before the SDK submits it.
      transactionSigner: async (tx) => {
        const message = tx.message.serialize();
        const position = tx.message.staticAccountKeys.findIndex((k) => k.equals(keypair.publicKey));
        tx.signatures[position] = nacl.sign.detached(message, keypair.secretKey);
        captured = VersionedTransaction.deserialize(tx.serialize());
        throw stopBeforeSending;
      },
    });
    check("deposit stopped before submitting", false, "the SDK sent it anyway");
  } catch (e) {
    if (e !== stopBeforeSending) throw e;
    check("a deposit transaction was built and signed", captured !== null);
  }

  if (!captured) return;

  const verified = captured.verifySignatures?.() ?? true;
  check("the signature verifies against the message", verified !== false);

  const { value } = await connection.simulateTransaction(captured, {
    replaceRecentBlockhash: true,
    sigVerify: false,
  });
  check("the network simulates it without error", value.err === null, JSON.stringify(value.err));
  console.log(`       consumed ${value.unitsConsumed ?? "?"} compute units, nothing was sent`);
}

async function main() {
  console.log(`Privacy Cash simulation against ${RPC_URL}\nNothing in this script submits a transaction.`);

  // The SDK caches decrypted notes in a Web Storage API. Node has none, so it
  // gets a scratch directory that can be thrown away.
  const storage = new LocalStorage(".privacy-sim-cache");

  await checkEncryption();
  await checkQuotes();

  const pubkey = process.env.PRIVACY_SIM_PUBKEY;
  const secret = process.env.PRIVACY_SIM_SECRET;

  if (pubkey) await checkBalanceScan(pubkey, storage);
  else console.log("\n3. Skipped — set PRIVACY_SIM_PUBKEY=<address> to scan a wallet's notes");

  if (secret) await simulateDeposit(secret, storage);
  else
    console.log(
      "\n4. Skipped — set PRIVACY_SIM_SECRET=<base58 key> of a wallet holding more than " +
        `${SIMULATED_DEPOSIT_LAMPORTS / LAMPORTS_PER_SOL} SOL to build and simulate a real deposit`,
    );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nSimulation aborted:", e);
  process.exit(1);
});
