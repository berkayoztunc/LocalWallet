import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  asAppError,
  shortKey,
  toSol,
  type Settings,
  type TokenScan,
  type Wallet,
  type WalletTokens,
} from "../lib/api";
import { addressUrl, clusterFromRpc, explorerInfo } from "../lib/explorer";
import {
  Banner,
  Button,
  EmptyState,
  Input,
  Kbd,
  Pill,
  RowActions,
  Skeleton,
  Spinner,
  StatCard,
  Table,
  Td,
  Th,
  Toolbar,
  Tr,
  cx,
} from "../components/ui";
import { Logo } from "../components/Logo";
import { TokenRow } from "../components/TokenRow";
import { ImportDialog } from "../components/ImportDialog";
import { CleanupDialog } from "../components/CleanupDialog";
import { SweepDialog } from "../components/SweepDialog";
import { SendDialog } from "../components/SendDialog";
import { FundedCleanupDialog } from "../components/FundedCleanupDialog";

type Dialog = "import" | "cleanup" | "funded-cleanup" | "sweep" | "send" | null;

/**
 * The smallest balance a wallet can actually transact from: the rent-exempt
 * minimum for a system account (890,880) plus a fee. The runtime validates the
 * fee payer on `balance - fee` before instructions run, so a wallet at or below
 * this cannot pay for its own close even though the close would return rent.
 *
 * Below this the row offers "Fund & close" instead of "Close". Only a display
 * heuristic — the backend prices each wallet exactly.
 */
const FEE_FLOOR_LAMPORTS = 900_000;

export function Dashboard({
  settings,
  onSettingsChanged,
  onOpenSettings,
  onLock,
}: {
  settings: Settings;
  onSettingsChanged: (s: Settings) => void;
  onOpenSettings: () => void;
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
  const [tokenTotals, setTokenTotals] = useState<TokenScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [sendTarget, setSendTarget] = useState<Wallet | null>(null);
  // Kept in state so the array identity is stable — an inline literal would
  // re-trigger the cleanup dialog's preview effect on every render.
  const [cleanupScope, setCleanupScope] = useState<{ pubkeys?: string[]; label?: string }>({});
  const [fundScope, setFundScope] = useState<{ pubkeys?: string[]; label?: string }>({});
  const searchRef = useRef<HTMLInputElement>(null);

  const loadWallets = useCallback(async () => {
    try {
      setWallets(await api.walletsList());
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
      setTokenTotals(scan);
      setTokens(Object.fromEntries(scan.wallets.map((w) => [w.pubkey, w])));
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    loadWallets();
  }, [loadWallets]);

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

  // Search matches label or address, so pasting a full pubkey finds its row.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return wallets;
    return wallets.filter(
      (w) => w.label.toLowerCase().includes(q) || w.pubkey.toLowerCase().includes(q),
    );
  }, [wallets, query]);

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
      await loadWallets();
    } catch (e) {
      setError(asAppError(e).message);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Band 1 — identity, search, actions */}
      <header className="border-b border-ink-600 bg-ink-850">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Logo size={26} />
            <span className="font-semibold tracking-tight">LocalWallet</span>
          </div>

          <div className="relative min-w-52 flex-1 sm:max-w-80">
            <Input
              ref={searchRef}
              className="h-9 pr-16 pl-8 text-[13px]"
              placeholder="Search label or address"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-mist-500">
              ⌕
            </span>
            {query ? (
              <button
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-1 text-mist-500 hover:text-mist-50"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                ✕
              </button>
            ) : (
              <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
                <Kbd>⌘K</Kbd>
              </span>
            )}
          </div>

          <Toolbar className="ml-auto">
            <Button onClick={() => setDialog("import")}>Import</Button>
            <Button onClick={refreshBalances} disabled={refreshing || wallets.length === 0}>
              {refreshing && <Spinner />} Balances
            </Button>
            <Button onClick={scanTokens} disabled={scanning || wallets.length === 0}>
              {scanning && <Spinner />} Scan tokens
            </Button>
            <Button
              onClick={() => {
                setCleanupScope({});
                setDialog("cleanup");
              }}
              disabled={wallets.length === 0}
            >
              Close accounts
            </Button>
            <Button
              onClick={() => {
                setFundScope({});
                setDialog("funded-cleanup");
              }}
              disabled={wallets.length === 0}
              title="Lend each empty wallet a fee, close its token accounts, then send the proceeds to the sweep destination"
            >
              Fund &amp; close
            </Button>
            <Button
              variant="primary"
              onClick={() => setDialog("sweep")}
              disabled={wallets.length === 0}
            >
              Collect all SOL
            </Button>
            <span className="mx-0.5 h-5 w-px bg-ink-600" />
            <Button variant="ghost" onClick={onOpenSettings}>
              Settings
            </Button>
            <Button variant="ghost" onClick={onLock}>
              Lock
            </Button>
          </Toolbar>
        </div>
      </header>

      {/* Band 2 — aggregates */}
      <div className="flex flex-wrap gap-2.5 border-b border-ink-600 px-4 py-3">
        <StatCard
          label="Wallets"
          value={wallets.length}
          sub={funded > 0 ? `${funded} funded` : undefined}
        />
        <StatCard label="Total SOL" value={toSol(total)} tone="brand" />
        <StatCard
          label="Token accounts"
          value={tokenTotals ? tokenTotals.total_accounts : "—"}
          sub={tokenTotals ? `${tokenTotals.total_with_balance} holding tokens` : "not scanned"}
          tone={tokenTotals ? "cyan" : "default"}
          loading={scanning}
        />
        <StatCard
          label="Reclaimable rent"
          value={tokenTotals ? toSol(tokenTotals.total_reclaimable_lamports) : "—"}
          sub={tokenTotals ? `${tokenTotals.total_empty} empty accounts` : "not scanned"}
          loading={scanning}
        />
        <StatCard
          label="Network"
          value={<span className="text-sm">{new URL(settings.rpc_url).host}</span>}
          sub={
            <span className="inline-flex items-center gap-1.5">
              <Pill tone={cluster === "mainnet" ? "accent" : "warn"}>{cluster}</Pill>
              <span>{explorerInfo(settings.explorer).name}</span>
            </span>
          }
        />
      </div>

      <div className="flex-1 overflow-auto p-4">
        {error && <Banner kind="error">{error}</Banner>}

        {settings.rpc_url.includes("api.mainnet-beta.solana.com") && wallets.length > 20 && (
          <Banner kind="warning">
            Public mainnet RPC with {wallets.length} wallets. It rate-limits aggressively at this
            size — set a dedicated endpoint in Settings before sweeping.
          </Banner>
        )}

        {wallets.length === 0 ? (
          <EmptyState title="No wallets yet">
            <p className="mb-4">Import private keys to get started.</p>
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
                <Th className="w-[22%]">Label</Th>
                <Th>Address</Th>
                <Th numeric className="w-36">
                  SOL
                </Th>
                <Th className="w-32">Tokens</Th>
                <Th className="w-64" />
              </tr>
            </thead>
            <tbody>
              {visible.map((w) => {
                const walletTokens = tokens[w.pubkey];
                const isOpen = expanded === w.pubkey;
                const isFunder = settings.funder_pubkey === w.pubkey;
                // A wallet holding rent it cannot pay to release is exactly
                // what the funded flow exists for. The backend re-checks the
                // real numbers, so this only decides which button to show.
                const hasRent = (walletTokens?.reclaimable_lamports ?? 0) > 0;
                const canPay = (balances[w.pubkey] ?? 0) >= FEE_FLOOR_LAMPORTS;
                return (
                  <Fragment key={w.pubkey}>
                    <Tr>
                      <Td>
                        {isFunder && (
                          <span className="mr-1.5 align-middle">
                            <Pill tone="accent">main</Pill>
                          </span>
                        )}
                        {editing === w.pubkey ? (
                          <Input
                            autoFocus
                            className="h-7 py-1"
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
                            className="-mx-1 max-w-full truncate rounded px-1 py-0.5 text-left outline-none hover:bg-ink-700 focus-visible:ring-2 focus-visible:ring-brand-500/40"
                            title="Click to rename"
                            onClick={() => {
                              setEditing(w.pubkey);
                              setDraftLabel(w.label);
                            }}
                          >
                            {w.label}
                          </button>
                        )}
                      </Td>

                      <Td>
                        <button
                          className="group/copy -mx-1 inline-flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 font-mono text-xs text-mist-300 outline-none hover:bg-ink-700 hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-brand-500/40"
                          title={`${w.pubkey}\nClick to copy`}
                          onClick={() => copyAddress(w.pubkey)}
                        >
                          <span className="truncate">{shortKey(w.pubkey)}</span>
                          <span
                            className={cx(
                              "text-[10px] whitespace-nowrap",
                              copied === w.pubkey
                                ? "text-brand-500"
                                : "text-mist-500 opacity-0 transition-opacity group-hover/copy:opacity-100",
                            )}
                          >
                            {copied === w.pubkey ? "copied" : "copy"}
                          </span>
                        </button>
                      </Td>

                      <Td numeric>
                        {balances[w.pubkey] === undefined && refreshing ? (
                          <Skeleton className="ml-auto h-4 w-16" />
                        ) : (
                          toSol(balances[w.pubkey])
                        )}
                      </Td>

                      <Td>
                        {scanning && !walletTokens ? (
                          <Skeleton className="h-4 w-12" />
                        ) : walletTokens ? (
                          <button
                            className={cx(
                              "-mx-1 rounded px-1.5 py-0.5 text-xs outline-none transition-colors",
                              "hover:bg-ink-700 focus-visible:ring-2 focus-visible:ring-brand-500/40",
                              walletTokens.total_accounts > 0 ? "text-cyan-brand" : "text-mist-500",
                            )}
                            aria-expanded={isOpen}
                            onClick={() => setExpanded(isOpen ? null : w.pubkey)}
                          >
                            {walletTokens.total_accounts}
                            {walletTokens.with_balance > 0 && ` · ${walletTokens.with_balance} held`}
                            {walletTokens.total_accounts > 0 && (isOpen ? " ▾" : " ▸")}
                          </button>
                        ) : (
                          <span className="text-xs text-mist-500">—</span>
                        )}
                      </Td>

                      <Td>
                        <RowActions>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-brand-500"
                            onClick={() => {
                              setSendTarget(w);
                              setDialog("send");
                            }}
                          >
                            Send
                          </Button>
                          {/* A wallet that can pay its own fee closes directly;
                              one that cannot has to be funded first. */}
                          {hasRent &&
                            (canPay ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-brand-500"
                                title={`Close empty token accounts and reclaim ${toSol(
                                  walletTokens.reclaimable_lamports,
                                )} SOL`}
                                onClick={() => {
                                  setCleanupScope({ pubkeys: [w.pubkey], label: w.label });
                                  setDialog("cleanup");
                                }}
                              >
                                Close
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-cyan-brand"
                                title={
                                  isFunder
                                    ? "The funding wallet cannot fund itself"
                                    : `Lend this wallet a fee, close its accounts and reclaim ${toSol(
                                        walletTokens.reclaimable_lamports,
                                      )} SOL`
                                }
                                disabled={isFunder}
                                onClick={() => {
                                  setFundScope({ pubkeys: [w.pubkey], label: w.label });
                                  setDialog("funded-cleanup");
                                }}
                              >
                                Fund &amp; close
                              </Button>
                            ))}
                          <Button
                            size="sm"
                            variant="ghost"
                            className={isFunder ? "text-brand-500" : undefined}
                            title={
                              isFunder
                                ? "This is the funding wallet — click to unset"
                                : "Use this wallet to fund fees for the others"
                            }
                            onClick={() => setFunder(isFunder ? null : w.pubkey)}
                          >
                            {isFunder ? "★" : "☆"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openUrl(addressUrl(settings, w.pubkey))}
                          >
                            Explorer ↗
                          </Button>
                          <span className="mx-0.5 h-4 w-px self-center bg-ink-600" />
                          <Button
                            size="sm"
                            variant="ghost"
                            className="hover:text-rose-400"
                            onClick={() => remove(w)}
                          >
                            Remove
                          </Button>
                        </RowActions>
                      </Td>
                    </Tr>

                    {isOpen && walletTokens && (
                      <tr>
                        <td colSpan={5} className="p-0">
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

        {query && visible.length > 0 && (
          <p className="mt-3 text-xs text-mist-500">
            Showing {visible.length} of {wallets.length} wallets.
          </p>
        )}
      </div>

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
            await scanTokens();
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
            await scanTokens();
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
