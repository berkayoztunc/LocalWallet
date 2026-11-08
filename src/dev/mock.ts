/**
 * Browser-only stand-in for the Tauri backend, so the interface can be opened
 * in a plain browser (`npm run dev`, then http://localhost:1420/?mock) and
 * inspected without building the app. It is loaded only in dev, only when the
 * page is not running inside Tauri, and holds fake data, never real keys.
 *
 * `?mock=unlock` and `?mock=setup` start on those screens instead.
 */
type Args = Record<string, unknown> | undefined;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function fakeKey(seed: number): string {
  let x = seed * 2654435761;
  let out = "";
  for (let i = 0; i < 44; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += B58[x % B58.length];
  }
  return out;
}

const LABELS = [
  "Trading",
  "Airdrop 01",
  "Airdrop 02",
  "Mint leftovers",
  "Old bot",
  "Cold storage",
  "Treasury",
  "Burner",
];
const now = Math.floor(Date.now() / 1000);
const lamports = [4_210_000_000, 120_000_000, 0, 890_880, 54_000_000, 9_870_000_000, 310_000_000, 1_500_000];
const tokenCounts = [3, 7, 2, 12, 0, 1, 4, 0];
const wallets = LABELS.map((label, i) => ({
  label,
  pubkey: fakeKey(i + 1),
  added_at: now - i * 86400,
  // Saved figures from the previous session, as the real backend returns them.
  snapshot: {
    lamports: lamports[i],
    balance_at: now - 1800,
    token_accounts: tokenCounts[i],
    tokens_with_balance: i % 3 === 0 ? 1 : 0,
    tokens_empty: Math.max(0, tokenCounts[i] - 1),
    reclaimable_lamports: Math.max(0, tokenCounts[i] - 1) * 2_039_280,
    tokens_at: now - 7200,
  },
}));

const settings = {
  rpc_url: "https://api.mainnet-beta.solana.com",
  destination_pubkey: wallets[5].pubkey,
  priority_fee_microlamports: 1000,
  concurrency: 8,
  commitment: "confirmed",
  auto_lock_minutes: 15,
  explorer: "solscan",
  funder_pubkey: wallets[0].pubkey,
  validator_directory: true,
  menubar: false,
  privacy_cash_ack: true,
};

const tokenRows = wallets.map((w, i) => ({
  pubkey: w.pubkey,
  label: w.label,
  accounts: [],
  total_accounts: [3, 7, 2, 12, 0, 1, 4, 0][i],
  empty_accounts: [2, 6, 2, 9, 0, 0, 1, 0][i],
  with_balance: [1, 1, 0, 3, 0, 1, 3, 0][i],
  frozen_accounts: 0,
  locked_accounts: [0, 0, 0, 1, 0, 0, 0, 0][i],
  reclaimable_lamports: [2_039_280, 12_235_680, 4_078_560, 18_353_520, 0, 0, 2_039_280, 0][i],
  error: null,
}));

const positions = {
  pump: {
    rows: [
      {
        owner_pubkey: wallets[0].pubkey,
        owner_label: wallets[0].label,
        vault: fakeKey(101),
        sol_lamports: 1_240_000_000,
        amm_vault: fakeKey(102),
        amm_lamports: 310_000_000,
        scanned_at: now - 600,
      },
    ],
    total_lamports: 1_550_000_000,
    last_scan_at: now - 600,
    checked: Object.fromEntries(wallets.slice(0, 6).map((w, i) => [w.pubkey, now - 600 - i * 3600])),
    skipped_fresh: 0,
    errors: [],
  },
  streams: {
    rows: [
      {
        owner_pubkey: wallets[1].pubkey,
        owner_label: wallets[1].label,
        address: fakeKey(201),
        contract_type: "VESTING",
        name: "Team vest",
        sender: fakeKey(202),
        mint: fakeKey(203),
        decimals: 6,
        total: "50000000000",
        claimed: "10000000000",
        locked: "40000000000",
        withdrawable: null,
        start: "2025-01-01T00:00:00Z",
        end: "2027-01-01T00:00:00Z",
        paused: false,
        scanned_at: now - 7200,
      },
    ],
    last_scan_at: now - 7200,
    checked: Object.fromEntries(wallets.slice(0, 4).map((w) => [w.pubkey, now - 7200])),
    skipped_fresh: 0,
    errors: [],
  },
};

const mode = new URLSearchParams(location.search).get("mock") || "dashboard";

const handlers: Record<string, (a: Args) => unknown> = {
  vault_status: () => ({
    exists: mode !== "setup",
    unlocked: mode === "dashboard" || mode === "",
    wallet_count: wallets.length,
  }),
  vault_unlock: () => ({ exists: true, unlocked: true, wallet_count: wallets.length }),
  vault_create: () => ({ exists: true, unlocked: true, wallet_count: wallets.length }),
  wallets_list: () => wallets,
  balances_refresh: () => wallets.map((w, i) => ({ pubkey: w.pubkey, lamports: lamports[i] })),
  settings_get: () => settings,
  settings_set: (a) => (a as { settings?: unknown })?.settings ?? settings,
  tokens_scan: () => ({
    wallets: tokenRows,
    total_accounts: 29,
    total_empty: 20,
    total_with_balance: 9,
    total_reclaimable_lamports: 38_746_320,
  }),
  positions_load: () => positions,
  positions_scan_pump: () => positions.pump,
  positions_scan_streams: () => positions.streams,
  positions_forget: () => positions,
  vault_lock: () => null,
  biometric_status: () => ({ available: true, enabled: mode === "unlock" }),
  biometric_enable: () => ({ available: true, enabled: true }),
  biometric_disable: () => ({ available: true, enabled: false }),
  vault_unlock_biometric: () => {
    throw { kind: "Invalid", message: "Authentication canceled." };
  },
  wallet_export_secret: () => ({
    base58: "5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyR4UKZvpe6E3AgLr7u7Ku4o5Y8N2yAEjVxPz8vQJc1f3GmXwqVbsD",
    json: "[" + Array.from({ length: 64 }, (_, i) => (i * 37) % 256).join(",") + "]",
  }),
};

let callbackId = 1;
const w = window as unknown as Record<string, unknown>;
w.__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Args) => {
    const h = handlers[cmd];
    if (h) return h(args);
    if (cmd.startsWith("plugin:event|")) return 0;
    console.info("[mock] unhandled command", cmd, args);
    return null;
  },
  transformCallback: () => callbackId++,
  unregisterCallback: () => {},
  convertFileSrc: (p: string) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
export {};
