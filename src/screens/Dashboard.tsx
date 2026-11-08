import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import {
  api,
  asAppError,
  onBalancesChanged,
  shortKey,
  toSol,
  type Settings,
  type Wallet,
  type WalletTokens,
} from "../lib/api";
import { addressUrl, clusterFromRpc, explorerInfo } from "../lib/explorer";
import { ago } from "../lib/time";
import {
  Banner,
  Button,
  EmptyState,
  Input,
  Kbd,
  Pill,
  Skeleton,
  Spinner,
  StatusBar,
  StatusDivider,
  StatusItem,
  Table,
  Td,
  Th,
  ToolbarDivider,
  ToolbarItem,
  Tr,
  cx,
} from "../components/ui";
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconExternal,
  IconEye,
  IconEyeOff,
  IconStake,
  IconKey,
  IconImport,
  IconRefresh,
  IconScan,
  IconCollect,
  IconGear,
  IconCoin,
  IconSearch,
  IconFund,
  IconLock,
  IconSend,
  IconStar,
  IconTrash,
} from "../components/icons";
import { TokenRow } from "../components/TokenRow";
import { ImportDialog } from "../components/ImportDialog";
import { CleanupDialog } from "../components/CleanupDialog";
import { SweepDialog } from "../components/SweepDialog";
import { SendDialog } from "../components/SendDialog";
import { FundedCleanupDialog } from "../components/FundedCleanupDialog";
import { StakeDialog } from "../components/StakeDialog";
import { PositionsDialog } from "../components/PositionsDialog";
import { ToolsDialog, type ToolItem } from "../components/ToolsDialog";
import { ExportKeyDialog } from "../components/ExportKeyDialog";
import { forgetPrivacyStorage } from "../lib/privacySessions";

/**
 * Privacy Cash pulls in a zero-knowledge prover and its circuits — megabytes
 * that most sessions never touch. Loading it only when the dialog opens keeps
 * it out of the startup path.
 */
const PrivacyDialog = lazy(() =>
  import("../components/PrivacyDialog").then((m) => ({ default: m.PrivacyDialog })),
);

type Dialog =
  | "import"
  | "cleanup"
  | "funded-cleanup"
  | "sweep"
  | "send"
  | "stake"
  | "positions"
  | "tools"
  | "export"
  | "privacy"
  | null;

/**
 * The smallest balance a wallet can actually transact from: the rent-exempt
 * minimum for a system account (890,880) plus a fee. The runtime validates the
 * fee payer on `balance - fee` before instructions run, so a wallet at or below
 * this cannot pay for its own close even though the close would return rent.
 *
 * Below this the row offers "Fund Fee & Close Accounts" instead of "Close Empty Token Accounts". Only a display
 * heuristic — the backend prices each wallet exactly.
 */
const FEE_FLOOR_LAMPORTS = 900_000;

export function Dashboard({
  settings,
  onSettingsChanged,
  onOpenSettings,
  onOpenStake,
  onLock,
}: {
  settings: Settings;
  onSettingsChanged: (s: Settings) => void;
  onOpenSettings: () => void;
  onOpenStake: () => void;
  onLock: () => void;
}) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [balances, setBalances] = useState<Record<string, number | null>>({});
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [tokens, setTokens] = useState<Record<string, WalletTokens>>({});
  const [scanning, setScanning] = useState(false);
  const [scanningWallet, setScanningWallet] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [sendTarget, setSendTarget] = useState<Wallet | null>(null);
  const [stakeTarget, setStakeTarget] = useState<Wallet | null>(null);
  const [toolsTarget, setToolsTarget] = useState<Wallet | null>(null);
  const [exportTarget, setExportTarget] = useState<Wallet | null>(null);
  const [privacyTarget, setPrivacyTarget] = useState<Wallet | null>(null);
  // Shielded balances are not fetched with the others: finding which pool notes
  // belong to a wallet means trying to decrypt every note in the pool, so each
  // one is scanned only when asked for. `poolStatus` carries the SDK's progress
  // line, since a scan runs long enough that a bare spinner reads as a hang.
  const [pool, setPool] = useState<Record<string, number>>({});
  const [poolScanning, setPoolScanning] = useState<string | null>(null);
  const [poolStatus, setPoolStatus] = useState<string>("");
  // Addresses are masked by default: this table is the screen most likely to
  // be shared or screenshotted, and a pubkey is a permanent handle on someone.
  const [addressesShown, setAddressesShown] = useState(false);
  const [version, setVersion] = useState("");
  // Kept in state so the array identity is stable — an inline literal would
  // re-trigger the dialogs' preview effects on every render.
  const [cleanupScope, setCleanupScope] = useState<{ pubkeys?: string[]; label?: string }>({});
  const [fundScope, setFundScope] = useState<{ pubkeys?: string[]; label?: string }>({});
  const searchRef = useRef<HTMLInputElement>(null);
  // Guards the focus listener below: alt-tabbing must not hammer the RPC.
  const lastRefreshAt = useRef(0);
  // When the balances on screen were last read: the saved time until a live
  // refresh replaces it.
  const [savedBalancesAt, setSavedBalancesAt] = useState<number | null>(null);

  const loadWallets = useCallback(async () => {
    try {
      const list = await api.walletsList();
      setWallets(list);
      // Show the last-known balances and token counts at once; live figures
      // (already in state, or arriving from a refresh) always win over these.
      setBalances((prev) => {
        const next = { ...prev };
        for (const w of list) {
          if (next[w.pubkey] === undefined && w.snapshot?.lamports != null) {
            next[w.pubkey] = w.snapshot.lamports;
          }
        }
        return next;
      });
      setTokens((prev) => {
        const next = { ...prev };
        for (const w of list) {
          const sn = w.snapshot;
          if (!next[w.pubkey] && sn?.token_accounts != null && sn.tokens_at != null) {
            next[w.pubkey] = {
              pubkey: w.pubkey,
              label: w.label,
              accounts: [],
              total_accounts: sn.token_accounts,
              empty_accounts: sn.tokens_empty ?? 0,
              with_balance: sn.tokens_with_balance ?? 0,
              frozen_accounts: 0,
              locked_accounts: 0,
              reclaimable_lamports: sn.reclaimable_lamports ?? 0,
              error: null,
              cached: sn.tokens_at,
            };
          }
        }
        return next;
      });
      setSavedBalancesAt(
        list.reduce<number | null>((m, w) => {
          const t = w.snapshot?.balance_at ?? null;
          return t !== null && (m === null || t > m) ? t : m;
        }, null),
      );
    } catch (e) {
      setError(asAppError(e).message);
    }
  }, []);

  const refreshBalances = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const list = await api.balancesRefresh();
      setBalances(Object.fromEntries(list.map((b) => [b.pubkey, b.lamports])));
      lastRefreshAt.current = Date.now();
      setSavedBalancesAt(Math.floor(Date.now() / 1000));
      // The menu bar shows the same total, so update it from the same data
      // rather than making the backend re-read every balance.
      const total = list.reduce((sum, b) => sum + (b.lamports ?? 0), 0);
      api.menubarUpdate(total).catch(() => {
        // A menu bar that cannot update is a cosmetic problem, never a reason
        // to fail the refresh the user actually asked for.
      });
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Two RPC calls per wallet, so this is an explicit action rather than part
  // of the balance refresh.
  const scanTokens = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const scan = await api.tokensScan();
      setTokens(Object.fromEntries(scan.wallets.map((w) => [w.pubkey, w])));
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setScanning(false);
    }
  }, []);

  /**
   * Scan one wallet instead of all of them.
   *
   * At 200 wallets a full scan is 400 RPC calls; checking a single wallet
   * should cost two. Results merge into the map rather than replacing it, so
   * scanning one row never discards what other rows already found.
   */
  const scanWallet = useCallback(async (pubkey: string) => {
    setScanningWallet(pubkey);
    setError(null);
    try {
      const scan = await api.tokensScan([pubkey]);
      setTokens((prev) => ({
        ...prev,
        ...Object.fromEntries(scan.wallets.map((w) => [w.pubkey, w])),
      }));
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setScanningWallet(null);
    }
  }, []);

  /**
   * Refresh token counts after an action changed them. A run scoped to a
   * single wallet only invalidates that wallet, so rescanning every other one
   * would be hundreds of RPC calls for nothing.
   */
  const rescanAfter = useCallback(
    async (pubkeys?: string[]) => {
      if (pubkeys?.length === 1) await scanWallet(pubkeys[0]);
      else await scanTokens();
    },
    [scanWallet, scanTokens],
  );

  useEffect(() => {
    loadWallets();
  }, [loadWallets]);

  // Reopening the app should show current numbers. Debounced, because macOS
  // fires focus on every alt-tab and each refresh is a real RPC round trip.
  useEffect(() => {
    const REFRESH_AFTER_MS = 30_000;
    const onFocus = () => {
      if (Date.now() - lastRefreshAt.current > REFRESH_AFTER_MS) refreshBalances();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshBalances]);

  // The tray refreshes balances itself now, so the table follows rather than
  // driving it. Without this the window would show figures the menu bar has
  // already superseded.
  useEffect(() => {
    const unlisten = onBalancesChanged(() => {
      api
        .balancesRefresh()
        .then((list) => {
          setBalances(Object.fromEntries(list.map((b) => [b.pubkey, b.lamports])));
          lastRefreshAt.current = Date.now();
        })
        .catch(() => {
          // The tray already reports failures in its own status line; the
          // table simply keeps what it had.
        });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    let active = true;
    getVersion().then((v) => {
      if (active) setVersion(v);
    });
    return () => {
      active = false;
    };
  }, []);

  // ⌘K or / focuses search, Escape clears it. Both ignore keystrokes already
  // aimed at an input so they never steal typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (e.key === "Escape" && target === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const total = useMemo(
    () => Object.values(balances).reduce<number>((sum, v) => sum + (v ?? 0), 0),
    [balances],
  );
  const funded = useMemo(
    () => Object.values(balances).filter((v) => (v ?? 0) > 0).length,
    [balances],
  );

  // Aggregated from the rows actually scanned, so scanning one wallet at a
  // time builds the same totals a full scan would.
  const tokenTotals = useMemo(() => {
    const scanned = Object.values(tokens);
    if (scanned.length === 0) return null;
    return {
      wallets: scanned.length,
      accounts: scanned.reduce((n, w) => n + w.total_accounts, 0),
      withBalance: scanned.reduce((n, w) => n + w.with_balance, 0),
      reclaimable: scanned.reduce((n, w) => n + w.reclaimable_lamports, 0),
      // Every figure is from the saved snapshot; nothing scanned live yet.
      savedOnly: scanned.every((w) => w.cached),
    };
  }, [tokens]);

  // Search matches label or address, so pasting a full pubkey finds its row.
  //
  // Rows then sort by balance, richest first, which is the order that answers
  // "where is the money" at a glance. Wallets whose balance has not been read
  // yet sort last rather than as zero — unknown is not empty, and floating
  // them to the top of an empty table would be noise.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? wallets.filter(
          (w) => w.label.toLowerCase().includes(q) || w.pubkey.toLowerCase().includes(q),
        )
      : wallets;
    const rank = (w: Wallet) => balances[w.pubkey] ?? -1;
    return [...matched].sort((a, b) => rank(b) - rank(a) || a.label.localeCompare(b.label));
  }, [wallets, query, balances]);

  /**
   * Read one wallet's shielded balance.
   *
   * Gated on the disclosure: this is the first thing in the app that talks to
   * Privacy Cash's relayer, and doing that silently from the wallet list would
   * contradict what the app promises about third-party requests. Unacknowledged,
   * the click opens the dialog instead, which is where the warning lives.
   *
   * The SDK is imported here rather than at the top of the file so that the
   * prover and its circuits stay out of the startup bundle.
   */
  async function scanPool(w: Wallet) {
    if (!settings.privacy_cash_ack) {
      setPrivacyTarget(w);
      setDialog("privacy");
      return;
    }
    setPoolScanning(w.pubkey);
    setPoolStatus("");
    setError(null);
    try {
      const { openPrivacySession, privateBalance } = await import("../lib/privacyCash");
      const session = await openPrivacySession(w.pubkey, settings.rpc_url);
      const { lamports } = await privateBalance(session, { onStatus: setPoolStatus });
      setPool((p) => ({ ...p, [w.pubkey]: lamports }));
    } catch (e) {
      setError(`${w.label}: ${asAppError(e).message}`);
    } finally {
      setPoolScanning(null);
      setPoolStatus("");
    }
  }

  const poolScanned = Object.keys(pool).length;
  const poolTotal = Object.values(pool).reduce((sum, n) => sum + n, 0);

  const cluster = clusterFromRpc(settings.rpc_url);

  async function copyAddress(pubkey: string) {
    await navigator.clipboard.writeText(pubkey);
    setCopied(pubkey);
    window.setTimeout(() => setCopied((c) => (c === pubkey ? null : c)), 1200);
  }

  // The funding wallet is a setting, so the choice survives restarts and is
  // the default in both the bulk and per-row funded flows.
  async function setFunder(pubkey: string | null) {
    try {
      onSettingsChanged(await api.settingsSet({ ...settings, funder_pubkey: pubkey }));
    } catch (e) {
      setError(asAppError(e).message);
    }
  }

  async function commitRename(pubkey: string) {
    const label = draftLabel.trim();
    setEditing(null);
    if (!label) return;
    try {
      await api.walletsRename(pubkey, label);
      await loadWallets();
    } catch (e) {
      setError(asAppError(e).message);
    }
  }

  async function remove(wallet: Wallet) {
    const ok = window.confirm(
      `Remove "${wallet.label}" from the vault?\n\n${wallet.pubkey}\n\nThe private key is deleted from this app. Anything still in the wallet becomes unreachable unless you have the key backed up elsewhere.`,
    );
    if (!ok) return;
    try {
      await api.walletsRemove(wallet.pubkey);
      // The wallet's Privacy Cash cache — including the plaintext commitment
      // indices that tie it to specific pool notes — would otherwise survive
      // under a pubkey this app no longer tracks.
      forgetPrivacyStorage(wallet.pubkey);
      await loadWallets();
    } catch (e) {
      setError(asAppError(e).message);
    }
  }

  /** Why the close tool is inactive: unscanned, no accounts, or accounts nothing
   *  can be done with (held, frozen, or owned by another close authority). */
  function closeBlockedReason(t: WalletTokens | undefined): string {
    if (!t) return "Scan this wallet first.";
    if (t.total_accounts === 0) return "This wallet has no token accounts.";
    const reasons = [
      t.with_balance && `${t.with_balance} hold a balance`,
      t.frozen_accounts && `${t.frozen_accounts} frozen`,
      t.locked_accounts && `${t.locked_accounts} locked by another close authority`,
    ].filter(Boolean);
    return reasons.length > 0
      ? `Nothing to close — ${reasons.join(", ")}.`
      : "No empty token accounts to close.";
  }

  /** Every per-wallet action, by name, for the Tools sheet. Each one closes the
   *  sheet by opening its own dialog (or by resetting `dialog` first). */
  function toolItems(w: Wallet): ToolItem[] {
    const t = tokens[w.pubkey];
    const isFunder = settings.funder_pubkey === w.pubkey;
    const hasRent = (t?.reclaimable_lamports ?? 0) > 0;
    const canPay = (balances[w.pubkey] ?? 0) >= FEE_FLOOR_LAMPORTS;
    const done = () => setDialog(null);

    const items: ToolItem[] = [
      {
        id: "send",
        group: "Move funds",
        label: "Send SOL to an Address",
        description: "Transfer SOL from this wallet, with a quote before you sign.",
        icon: <IconSend />,
        tone: "accent",
        onSelect: () => {
          setSendTarget(w);
          setDialog("send");
        },
      },
      {
        id: "privacy",
        group: "Move funds",
        label: "Send Privately (Privacy Cash)",
        description: "Pay an address through the Privacy Cash pool.",
        icon: <IconLock />,
        tone: "purple",
        onSelect: () => {
          setPrivacyTarget(w);
          setDialog("privacy");
        },
      },
      {
        id: "stake",
        group: "Move funds",
        label: "Stake to a Validator",
        description: "Delegate SOL from this wallet to a validator.",
        icon: <IconStake />,
        tone: "green",
        onSelect: () => {
          setStakeTarget(w);
          setDialog("stake");
        },
      },
    ];

    // A wallet that can pay its own fee closes directly; one that cannot has to
    // be funded first. Only the applicable one is enabled.
    if (hasRent && canPay) {
      items.push({
        id: "close",
        group: "Token accounts",
        label: "Close Empty Token Accounts",
        description: `Close ${t.empty_accounts} empty account${t.empty_accounts === 1 ? "" : "s"} and reclaim ${toSol(t.reclaimable_lamports)} SOL.`,
        icon: <IconClose />,
        tone: "orange",
        onSelect: () => {
          setCleanupScope({ pubkeys: [w.pubkey], label: w.label });
          setDialog("cleanup");
        },
      });
    } else if (hasRent) {
      items.push({
        id: "fund-close",
        group: "Token accounts",
        label: "Fund Fee & Close Accounts",
        description: isFunder
          ? "The funding wallet cannot fund itself."
          : `Too empty to pay a fee. Lend it one, close its accounts and reclaim ${toSol(t.reclaimable_lamports)} SOL.`,
        icon: <IconFund />,
        disabled: isFunder,
        tone: "yellow",
        onSelect: () => {
          setFundScope({ pubkeys: [w.pubkey], label: w.label });
          setDialog("funded-cleanup");
        },
      });
    } else {
      items.push({
        id: "close",
        group: "Token accounts",
        label: "Close Empty Token Accounts",
        description: closeBlockedReason(t),
        icon: <IconClose />,
        disabled: true,
        onSelect: done,
      });
    }

    items.push(
      {
        id: "funder",
        group: "Wallet",
        label: isFunder ? "Remove as Funding Wallet" : "Set as Funding Wallet",
        description: isFunder
          ? "This wallet funds fees for the others. Click to unset."
          : "Use this wallet to fund fees for the others.",
        icon: <IconStar filled={isFunder} />,
        tone: "yellow",
        onSelect: () => {
          done();
          void setFunder(isFunder ? null : w.pubkey);
        },
      },
      {
        id: "copy",
        group: "Wallet",
        label: "Copy Address",
        description: w.pubkey,
        icon: <IconCopy />,
        tone: "plain",
        onSelect: () => {
          done();
          void copyAddress(w.pubkey);
        },
      },
      {
        id: "explorer",
        group: "Wallet",
        label: `View on ${explorerInfo(settings.explorer).name}`,
        description: "Open this address in your block explorer.",
        icon: <IconExternal />,
        tone: "teal",
        onSelect: () => {
          done();
          void openUrl(addressUrl(settings, w.pubkey));
        },
      },
      {
        id: "export",
        group: "Danger zone",
        label: "Export Private Key…",
        description: "Show this wallet's secret key. Asks for your password and a confirmation.",
        icon: <IconKey />,
        tone: "orange",
        onSelect: () => {
          setExportTarget(w);
          setDialog("export");
        },
      },
      {
        id: "remove",
        group: "Danger zone",
        label: "Remove Wallet from Vault",
        description: "Delete this wallet's key from the app. Back it up first.",
        icon: <IconTrash />,
        tone: "danger",
        onSelect: () => {
          done();
          void remove(w);
        },
      },
    );
    return items;
  }

  const noWallets = wallets.length === 0;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar: icon over label, grouped like a macOS toolbar. */}
      <header className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-white/10 bg-ink-850 px-2.5 pb-1.5">
        <ToolbarItem
          icon={<IconImport size={18} />}
          label="Import Keys"
          title="Import private keys into the vault"
          onClick={() => setDialog("import")}
        />
        <ToolbarItem
          icon={<IconRefresh size={18} />}
          label="Refresh Balances"
          title="Read every wallet's SOL balance again"
          busy={refreshing}
          onClick={refreshBalances}
          disabled={refreshing || noWallets}
        />
        <ToolbarItem
          icon={<IconScan size={18} />}
          label="Scan Tokens"
          title="Scan every wallet for token accounts"
          busy={scanning}
          onClick={scanTokens}
          disabled={scanning || noWallets}
        />

        <ToolbarDivider />

        <ToolbarItem
          icon={<IconClose size={18} />}
          label="Close Token Accounts"
          title="Close empty token accounts and reclaim their rent"
          onClick={() => {
            setCleanupScope({});
            setDialog("cleanup");
          }}
          disabled={noWallets}
        />
        <ToolbarItem
          icon={<IconFund size={18} />}
          label="Fund & Close Accounts"
          title="Lend each empty wallet a fee, close its token accounts, then send the proceeds to the sweep destination"
          onClick={() => {
            setFundScope({});
            setDialog("funded-cleanup");
          }}
          disabled={noWallets}
        />

        <ToolbarDivider />

        <ToolbarItem
          tone="accent"
          icon={<IconCollect size={18} />}
          label="Collect All SOL"
          title="Collect SOL from every wallet into one destination"
          onClick={() => setDialog("sweep")}
          disabled={noWallets}
        />
        <ToolbarItem
          icon={<IconStake size={18} />}
          label="Staking"
          title="Your stake accounts, and the validator list"
          onClick={onOpenStake}
        />
        <ToolbarItem
          icon={<IconCoin size={18} />}
          label="Creator Fees & Locks"
          title="Pump.fun creator fees and Streamflow locks"
          onClick={() => setDialog("positions")}
          disabled={noWallets}
        />

        <div className="relative mx-2 ml-auto min-w-28 flex-1 self-center sm:max-w-60">
          <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-mist-500">
            <IconSearch size={13} />
          </span>
          <Input
            ref={searchRef}
            className="pr-12 pl-7"
            placeholder="Search"
            aria-label="Search label or address"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              className="absolute top-1/2 right-1.5 -translate-y-1/2 px-1 text-mist-500 hover:text-mist-50"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              ✕
            </button>
          ) : (
            <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2">
              <Kbd>⌘K</Kbd>
            </span>
          )}
        </div>

        <ToolbarDivider />
        <ToolbarItem
          icon={<IconGear size={18} />}
          label="Settings"
          onClick={onOpenSettings}
        />
        <ToolbarItem icon={<IconLock size={18} />} label="Lock Vault" title="Lock the vault" onClick={onLock} />
      </header>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-auto p-2.5">
        {error && <Banner kind="error">{error}</Banner>}

        {settings.rpc_url.includes("api.mainnet-beta.solana.com") && wallets.length > 20 && (
          <Banner kind="warning">
            Public mainnet RPC with {wallets.length} wallets. It rate-limits aggressively at this
            size — set a dedicated endpoint in Settings before sweeping.
          </Banner>
        )}

        {noWallets ? (
          <EmptyState title="No wallets yet">
            <p className="mb-3">Import private keys to get started.</p>
            <Button variant="primary" onClick={() => setDialog("import")}>
              Import private keys
            </Button>
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title={`Nothing matches “${query}”`}>
            <Button variant="ghost" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-[20%]">Label</Th>
                <Th className="">
                  <span className="inline-flex items-center gap-1.5">
                    Address
                    <button
                      className="text-mist-500 outline-none transition-colors hover:text-mist-50 focus-visible:ring-1 focus-visible:ring-brand-500"
                      title={addressesShown ? "Hide addresses" : "Reveal addresses"}
                      aria-pressed={addressesShown}
                      onClick={() => setAddressesShown((v) => !v)}
                    >
                      {addressesShown ? <IconEyeOff size={11} /> : <IconEye size={11} />}
                    </button>
                  </span>
                </Th>
                <Th numeric className="w-32">
                  SOL
                </Th>
                <Th
                  numeric
                  className="w-28"
                  title="Shielded balance held in Privacy Cash. Scanned per wallet on request — finding a wallet's notes means trying every note in the pool against its key, so it cannot be read in bulk."
                >
                  Pool
                </Th>
                <Th className="w-28">Tokens</Th>
                <Th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {visible.map((w) => {
                const walletTokens = tokens[w.pubkey];
                const isOpen = expanded === w.pubkey;
                const isFunder = settings.funder_pubkey === w.pubkey;
                return (
                  <Fragment key={w.pubkey}>
                    <Tr>
                      <Td>
                        <div className="flex items-center gap-1.5">
                          {isFunder && <Pill tone="accent">main</Pill>}
                          {editing === w.pubkey ? (
                            <Input
                              autoFocus
                              className="h-5"
                              value={draftLabel}
                              onChange={(e) => setDraftLabel(e.target.value)}
                              onBlur={() => commitRename(w.pubkey)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitRename(w.pubkey);
                                if (e.key === "Escape") setEditing(null);
                              }}
                            />
                          ) : (
                            <button
                              className="-mx-1 max-w-full truncate px-1 text-left outline-none hover:bg-ink-700 focus-visible:ring-1 focus-visible:ring-brand-500"
                              title="Click to rename"
                              onClick={() => {
                                setEditing(w.pubkey);
                                setDraftLabel(w.label);
                              }}
                            >
                              {w.label}
                            </button>
                          )}
                        </div>
                      </Td>

                      <Td className="">
                        {/* Masking is display only: the tooltip and the copy
                            both still carry the real address, so a hidden row
                            stays as usable as a shown one. */}
                        <button
                          className="group/copy -mx-1 inline-flex max-w-full items-center gap-1.5 px-1 font-mono text-[11px] text-mist-300 outline-none hover:bg-ink-700 hover:text-mist-50 focus-visible:ring-1 focus-visible:ring-brand-500"
                          title={`${w.pubkey}\nClick to copy`}
                          onClick={() => copyAddress(w.pubkey)}
                        >
                          <span className="truncate">
                            {addressesShown ? shortKey(w.pubkey) : "••••••••••••"}
                          </span>
                          <span
                            className={cx(
                              "shrink-0",
                              copied === w.pubkey
                                ? "text-brand-500"
                                : "text-mist-500 opacity-0 transition-opacity group-hover/copy:opacity-100",
                            )}
                          >
                            {copied === w.pubkey ? <IconCheck size={11} /> : <IconCopy size={11} />}
                          </span>
                        </button>
                      </Td>

                      <Td numeric className=" font-mono">
                        {balances[w.pubkey] === undefined && refreshing ? (
                          <Skeleton className="ml-auto h-3 w-14" />
                        ) : (
                          toSol(balances[w.pubkey])
                        )}
                      </Td>

                      {/* Same idea as the Tokens cell: unscanned it offers to
                          scan this one wallet, scanned it shows the figure. A
                          shielded balance cannot be read in bulk. */}
                      <Td numeric className=" font-mono">
                        {poolScanning === w.pubkey ? (
                          <span
                            className="inline-flex items-center gap-1.5 text-[11px] text-mist-500"
                            title={poolStatus || "Reading the pool"}
                          >
                            <Spinner /> scanning
                          </span>
                        ) : pool[w.pubkey] !== undefined ? (
                          <button
                            className={cx(
                              "-mx-1 px-1 font-mono outline-none transition-colors",
                              "hover:bg-ink-700 focus-visible:ring-1 focus-visible:ring-brand-500",
                              pool[w.pubkey] > 0 ? "text-cyan-brand" : "text-mist-500",
                            )}
                            title="Re-read this wallet's shielded balance"
                            disabled={poolScanning !== null}
                            onClick={() => scanPool(w)}
                          >
                            {toSol(pool[w.pubkey])}
                          </button>
                        ) : (
                          <button
                            className="-mx-1 px-1 text-[11px] text-mist-500 outline-none transition-colors hover:bg-ink-700 hover:text-cyan-brand focus-visible:ring-1 focus-visible:ring-brand-500 disabled:opacity-40"
                            title={
                              poolScanning
                                ? "Another wallet is being scanned — they cannot run at the same time"
                                : `Read ${w.label}'s shielded balance. Tries all ~750,000 pool notes against its key, so the first scan of a wallet takes a while.`
                            }
                            disabled={poolScanning !== null}
                            onClick={() => scanPool(w)}
                          >
                            scan
                          </button>
                        )}
                      </Td>

                      {/* The cell is the control: unscanned it offers to scan
                          just this wallet, scanned it expands the detail. */}
                      <Td className="">
                        {(scanning && !walletTokens) || scanningWallet === w.pubkey ? (
                          <span className="inline-flex items-center gap-1.5 text-[11px] text-mist-500">
                            <Spinner /> scanning
                          </span>
                        ) : walletTokens ? (
                          <button
                            className={cx(
                              "-mx-1 px-1 text-[11px] outline-none transition-colors",
                              "hover:bg-ink-700 focus-visible:ring-1 focus-visible:ring-brand-500",
                              walletTokens.cached
                                ? "text-mist-500"
                                : walletTokens.total_accounts > 0
                                  ? "text-cyan-brand"
                                  : "text-mist-500",
                            )}
                            aria-expanded={walletTokens.cached ? undefined : isOpen}
                            title={
                              walletTokens.cached
                                ? `Saved from ${ago(walletTokens.cached)}. Click to scan again.`
                                : walletTokens.total_accounts > 0
                                  ? "Show token accounts"
                                  : "No token accounts"
                            }
                            onClick={() =>
                              walletTokens.cached
                                ? scanWallet(w.pubkey)
                                : setExpanded(isOpen ? null : w.pubkey)
                            }
                          >
                            {walletTokens.total_accounts}
                            {walletTokens.with_balance > 0 && ` · ${walletTokens.with_balance} held`}
                            {walletTokens.cached
                              ? " ↻"
                              : walletTokens.total_accounts > 0 && (isOpen ? " ▾" : " ▸")}
                          </button>
                        ) : (
                          <button
                            className="-mx-1 px-1 text-[11px] text-mist-500 outline-none transition-colors hover:bg-ink-700 hover:text-cyan-brand focus-visible:ring-1 focus-visible:ring-brand-500"
                            title={`Scan ${w.label} for token accounts (2 RPC calls)`}
                            disabled={scanning}
                            onClick={() => scanWallet(w.pubkey)}
                          >
                            scan
                          </button>
                        )}
                      </Td>

                      <Td>
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            onClick={() => {
                              setToolsTarget(w);
                              setDialog("tools");
                            }}
                          >
                            Tools
                          </Button>
                        </div>
                      </Td>
                    </Tr>

                    {isOpen && walletTokens && !walletTokens.cached && (
                      <tr>
                        <td colSpan={6} className="p-0">
                          <TokenRow tokens={walletTokens} settings={settings} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>

      {/* Status bar — the numbers that used to sit in a band of cards above the
          table, now permanently visible at a fraction of the space. */}
      <StatusBar>
        <StatusItem value={query ? `${visible.length}/${wallets.length}` : wallets.length} label="wallets" />
        <StatusDivider />
        <StatusItem value={`${toSol(total)} SOL`} tone="brand" />
        <StatusItem value={`${funded} funded`} />
        {savedBalancesAt && <StatusItem value={ago(savedBalancesAt)} label="updated" />}
        {/* Only ever a partial total: it covers the wallets scanned so far,
            which is why it says how many that is. */}
        {poolScanned > 0 && (
          <>
            <StatusDivider />
            <StatusItem
              value={`${toSol(poolTotal)} in pool`}
              label={`${poolScanned}/${wallets.length} scanned`}
              tone="cyan"
            />
          </>
        )}
        <StatusDivider />
        {tokenTotals ? (
          <>
            <StatusItem
              value={tokenTotals.accounts}
              label={tokenTotals.savedOnly ? "token accts (saved)" : "token accts"}
              tone="cyan"
            />
            <StatusItem value={`${toSol(tokenTotals.reclaimable)} reclaimable`} />
            {tokenTotals.wallets < wallets.length && (
              <StatusItem value={`${tokenTotals.wallets}/${wallets.length} scanned`} />
            )}
          </>
        ) : (
          <StatusItem value="tokens not scanned" />
        )}
        <span className="flex-1" />
        <StatusItem value={cluster} tone={cluster === "mainnet" ? undefined : "warn"} />
        <StatusDivider />
        <StatusItem value={new URL(settings.rpc_url).host} />
        <StatusDivider />
        <StatusItem value={explorerInfo(settings.explorer).name} />
        {version && (
          <>
            <StatusDivider />
            <StatusItem value={`v${version}`} />
          </>
        )}
      </StatusBar>

      {dialog === "import" && (
        <ImportDialog onClose={() => setDialog(null)} onImported={loadWallets} />
      )}
      {dialog === "cleanup" && (
        <CleanupDialog
          pubkeys={cleanupScope.pubkeys}
          scopeLabel={cleanupScope.label}
          onClose={() => setDialog(null)}
          onFinished={async () => {
            await refreshBalances();
            await rescanAfter(cleanupScope.pubkeys);
          }}
        />
      )}
      {dialog === "funded-cleanup" && (
        <FundedCleanupDialog
          settings={settings}
          wallets={wallets}
          balances={balances}
          pubkeys={fundScope.pubkeys}
          scopeLabel={fundScope.label}
          onClose={() => setDialog(null)}
          onOpenSettings={onOpenSettings}
          onFinished={async () => {
            await refreshBalances();
            await rescanAfter(fundScope.pubkeys);
          }}
        />
      )}
      {dialog === "sweep" && (
        <SweepDialog
          settings={settings}
          defaultDestination={settings.destination_pubkey ?? ""}
          onClose={() => setDialog(null)}
          onFinished={refreshBalances}
        />
      )}
      {dialog === "stake" && stakeTarget && (
        <StakeDialog
          settings={settings}
          wallet={stakeTarget}
          onClose={() => {
            setDialog(null);
            setStakeTarget(null);
          }}
          onStaked={refreshBalances}
        />
      )}
      {dialog === "tools" && toolsTarget && (
        <ToolsDialog
          title={toolsTarget.label}
          subtitle={toolsTarget.pubkey}
          items={toolItems(toolsTarget)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "export" && exportTarget && (
        <ExportKeyDialog
          wallet={exportTarget}
          onClose={() => {
            setDialog(null);
            setExportTarget(null);
          }}
        />
      )}
      {dialog === "positions" && (
        <PositionsDialog settings={settings} wallets={wallets} onClose={() => setDialog(null)} />
      )}
      {dialog === "privacy" && privacyTarget && (
        <Suspense fallback={null}>
          <PrivacyDialog
            settings={settings}
            wallet={privacyTarget}
            wallets={wallets}
            balance={balances[privacyTarget.pubkey] ?? null}
            pooled={pool[privacyTarget.pubkey] ?? null}
            onSettingsChanged={onSettingsChanged}
            onClose={() => {
              setDialog(null);
              setPrivacyTarget(null);
            }}
            onFinished={(pooled) => {
              refreshBalances();
              // The dialog has just read this wallet's pool balance as part of
              // the operation, so take its figure rather than making the row
              // re-scan for it.
              if (pooled !== null) {
                setPool((p) => ({ ...p, [privacyTarget.pubkey]: pooled }));
              }
            }}
          />
        </Suspense>
      )}
      {dialog === "send" && sendTarget && (
        <SendDialog
          settings={settings}
          wallet={sendTarget}
          balance={balances[sendTarget.pubkey] ?? null}
          defaultDestination={settings.destination_pubkey ?? ""}
          onClose={() => {
            setDialog(null);
            setSendTarget(null);
          }}
          onSent={refreshBalances}
        />
      )}
    </div>
  );
}
