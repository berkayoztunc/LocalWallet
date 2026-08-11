import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Errors from Rust arrive as { kind, message }; `kind` is what UI branches on. */
export type ErrorKind =
  | "Locked"
  | "VaultExists"
  | "NoVault"
  | "BadPassword"
  | "WeakPassword"
  | "CorruptVault"
  | "Invalid"
  | "UnknownWallet"
  | "Rpc"
  | "Io";

export interface AppError {
  kind: ErrorKind;
  message: string;
}

export function asAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    return e as AppError;
  }
  return { kind: "Invalid", message: String(e) };
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  wallet_count: number;
}

export interface Wallet {
  label: string;
  pubkey: string;
  added_at: number;
}

export interface Balance {
  pubkey: string;
  lamports: number | null;
}

export interface Settings {
  rpc_url: string;
  destination_pubkey: string | null;
  priority_fee_microlamports: number;
  concurrency: number;
  commitment: "processed" | "confirmed" | "finalized";
  auto_lock_minutes: number;
  explorer: string;
  funder_pubkey: string | null;
  validator_directory: boolean;
}

export interface RpcHealth {
  ok: boolean;
  version: string | null;
  latency_ms: number;
  error: string | null;
}

export interface ImportLineError {
  line: number;
  message: string;
  preview: string;
}

export interface ImportReport {
  imported: number;
  duplicates: number;
  failed: ImportLineError[];
}

export interface SendQuote {
  from: string;
  destination: string;
  balance: number;
  fee: number;
  amount: number;
  remaining: number;
  max: boolean;
}

export interface SendResult {
  signature: string;
  amount: number;
}

export interface SweepPlanItem {
  pubkey: string;
  label: string;
  lamports: number;
  fee: number;
  net: number;
  skip_reason: string | null;
}

export interface SweepPlan {
  destination: string;
  items: SweepPlanItem[];
  total_net: number;
  total_fees: number;
  sweepable: number;
  skipped: number;
}

export interface SweepProgress {
  pubkey: string;
  label: string;
  status: "sent" | "skipped" | "failed";
  lamports: number;
  signature: string | null;
  error: string | null;
  done: number;
  total: number;
}

export interface TokenAccount {
  address: string;
  mint: string;
  program: "spl-token" | "spl-token-2022";
  /** Raw integer balance as a string — a u64 of raw units can exceed Number precision. */
  amount: string;
  decimals: number;
  ui_amount: number;
  frozen: boolean;
  /** Set when a third party holds close rights — we cannot close these. */
  close_authority: string | null;
}

export interface WalletTokens {
  pubkey: string;
  label: string;
  accounts: TokenAccount[];
  total_accounts: number;
  empty_accounts: number;
  with_balance: number;
  frozen_accounts: number;
  /** Empty accounts a different close authority has locked us out of. */
  locked_accounts: number;
  reclaimable_lamports: number;
  error: string | null;
}

export interface TokenScan {
  wallets: WalletTokens[];
  total_accounts: number;
  total_empty: number;
  total_with_balance: number;
  total_reclaimable_lamports: number;
}

export interface CleanupPreviewItem {
  pubkey: string;
  label: string;
  accounts: TokenAccount[];
  reclaimable_lamports: number;
  error: string | null;
}

export interface CleanupPreview {
  items: CleanupPreviewItem[];
  total_accounts: number;
  total_reclaimable_lamports: number;
}

export interface CleanupProgress {
  pubkey: string;
  label: string;
  status: "closed" | "skipped" | "failed";
  accounts_closed: number;
  reclaimed_lamports: number;
  signatures: string[];
  error: string | null;
  done: number;
  total: number;
}

export interface FundedCleanupItem {
  pubkey: string;
  label: string;
  closable_accounts: number;
  balance: number;
  funding_needed: number;
  reclaimable: number;
  fees: number;
  skip_reason: string | null;
}

export interface FundedCleanupPlan {
  funder: string;
  funder_label: string;
  funder_balance: number;
  destination: string;
  returns_to_funder: boolean;
  items: FundedCleanupItem[];
  total_funding: number;
  total_reclaimable: number;
  total_fees: number;
  destination_receives: number;
  eligible: number;
  skipped: number;
  underfunded: boolean;
}

export interface FundedCleanupProgress {
  pubkey: string;
  label: string;
  stage: "funding" | "closing" | "returning" | "done" | "skipped" | "failed";
  funded_lamports: number;
  accounts_closed: number;
  reclaimed_lamports: number;
  returned_lamports: number;
  signatures: string[];
  error: string | null;
  done: number;
  total: number;
}

export type StakeStatus = "activating" | "active" | "deactivating" | "inactive";

export interface StakeAccount {
  address: string;
  owner_pubkey: string;
  owner_label: string;
  vote_account: string | null;
  lamports: number;
  delegated: number;
  rent_exempt_reserve: number;
  activation_epoch: number;
  deactivation_epoch: number | null;
  status: StakeStatus;
  /** False when the vault does not hold the key this action needs. */
  can_deactivate: boolean;
  can_withdraw: boolean;
}

export interface StakeScan {
  accounts: StakeAccount[];
  current_epoch: number;
  total_staked: number;
  total_withdrawable: number;
  active_count: number;
  errors: string[];
}

export interface StakeProgress {
  address: string;
  label: string;
  status: "deactivated" | "withdrawn" | "failed";
  lamports: number;
  signature: string | null;
  error: string | null;
  done: number;
  total: number;
}

export interface Validator {
  vote_pubkey: string;
  node_pubkey: string;
  activated_stake: number;
  commission: number;
  delinquent: boolean;
  epoch_credits: number;
  /** Directory decoration — absent when the directory is off or unreachable. */
  name?: string | null;
  website?: string | null;
  image?: string | null;
  apy?: number | null;
}

export interface ValidatorList {
  validators: Validator[];
  total_active_stake: number;
  delinquent_count: number;
  directory_used: boolean;
  directory_error: string | null;
}

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function toSol(lamports: number | null | undefined): string {
  if (lamports === null || lamports === undefined) return "—";
  return (lamports / LAMPORTS_PER_SOL).toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 9,
  });
}

/**
 * Truncate an address for display: `7xKXtg....9fRmYt`.
 *
 * Only for lists and labels. Never truncate an address the user is about to
 * send funds to — an attacker can mint a vanity address sharing the first and
 * last characters of yours, and a shortened confirmation is exactly what makes
 * that swap invisible. Confirmation surfaces render the address in full.
 */
export function shortKey(pubkey: string, head = 6, tail = 6): string {
  return pubkey.length > head + tail + 4
    ? `${pubkey.slice(0, head)}....${pubkey.slice(-tail)}`
    : pubkey;
}

export const api = {
  vaultStatus: () => invoke<VaultStatus>("vault_status"),
  vaultCreate: (password: string) => invoke<VaultStatus>("vault_create", { password }),
  vaultUnlock: (password: string) => invoke<VaultStatus>("vault_unlock", { password }),
  vaultLock: () => invoke<void>("vault_lock"),
  vaultChangePassword: (oldPassword: string, newPassword: string) =>
    invoke<void>("vault_change_password", { oldPassword, newPassword }),
  vaultExport: (destination: string) => invoke<string>("vault_export", { destination }),

  walletsList: () => invoke<Wallet[]>("wallets_list"),
  walletsImport: (text: string, labelPrefix?: string) =>
    invoke<ImportReport>("wallets_import", {
      request: { text, label_prefix: labelPrefix ?? null },
    }),
  walletsRemove: (pubkey: string) => invoke<void>("wallets_remove", { pubkey }),
  walletsRename: (pubkey: string, label: string) =>
    invoke<void>("wallets_rename", { pubkey, label }),

  balancesRefresh: () => invoke<Balance[]>("balances_refresh"),

  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSet: (settings: Settings) => invoke<Settings>("settings_set", { settings }),
  rpcTest: (url: string) => invoke<RpcHealth>("rpc_test", { url }),

  tokensScan: (pubkeys?: string[]) =>
    invoke<TokenScan>("tokens_scan", { pubkeys: pubkeys ?? null }),

  cleanupPreview: (pubkeys?: string[]) =>
    invoke<CleanupPreview>("cleanup_preview", { pubkeys: pubkeys ?? null }),
  cleanupRun: (pubkeys?: string[]) =>
    invoke<CleanupProgress[]>("cleanup_run", { pubkeys: pubkeys ?? null }),

  fundedCleanupPreview: (funder: string, pubkeys?: string[]) =>
    invoke<FundedCleanupPlan>("funded_cleanup_preview", { funder, pubkeys: pubkeys ?? null }),
  fundedCleanupRun: (funder: string, pubkeys?: string[]) =>
    invoke<FundedCleanupProgress[]>("funded_cleanup_run", { funder, pubkeys: pubkeys ?? null }),

  stakeScan: (pubkeys?: string[]) => invoke<StakeScan>("stake_scan", { pubkeys: pubkeys ?? null }),
  /** `accounts` is a list of [ownerPubkey, stakeAccount] pairs. */
  stakeDeactivate: (accounts: [string, string][]) =>
    invoke<StakeProgress[]>("stake_deactivate", { accounts }),
  stakeWithdraw: (owner: string, stakeAccount: string, destination?: string) =>
    invoke<StakeProgress>("stake_withdraw", {
      owner,
      stakeAccount,
      destination: destination ?? null,
    }),
  validatorsList: () => invoke<ValidatorList>("validators_list"),

  sendQuote: (from: string, destination: string, lamports: number | null) =>
    invoke<SendQuote>("send_quote", { from, destination, lamports }),
  sendSol: (from: string, destination: string, lamports: number | null) =>
    invoke<SendResult>("send_sol", { from, destination, lamports }),

  sweepPreview: (destination: string, pubkeys?: string[]) =>
    invoke<SweepPlan>("sweep_preview", { destination, pubkeys: pubkeys ?? null }),
  sweepRun: (destination: string, pubkeys?: string[]) =>
    invoke<SweepProgress[]>("sweep_run", { destination, pubkeys: pubkeys ?? null }),
};

export function onSweepProgress(cb: (p: SweepProgress) => void): Promise<UnlistenFn> {
  return listen<SweepProgress>("sweep://progress", (e) => cb(e.payload));
}

export function onCleanupProgress(cb: (p: CleanupProgress) => void): Promise<UnlistenFn> {
  return listen<CleanupProgress>("cleanup://progress", (e) => cb(e.payload));
}

export function onStakeProgress(cb: (p: StakeProgress) => void): Promise<UnlistenFn> {
  return listen<StakeProgress>("stake://progress", (e) => cb(e.payload));
}

export function onFundedCleanupProgress(
  cb: (p: FundedCleanupProgress) => void,
): Promise<UnlistenFn> {
  return listen<FundedCleanupProgress>("funded-cleanup://progress", (e) => cb(e.payload));
}
