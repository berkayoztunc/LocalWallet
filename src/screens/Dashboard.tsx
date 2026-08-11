import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
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
  ButtonGroup,
  EmptyState,
  Input,
  Kbd,
  Pill,
  RowActions,
  IconButton,
  Skeleton,
  Spinner,
  StatusBar,
  StatusDivider,
  StatusItem,
  Table,
  Td,
  Th,
  Toolbar,
  Tr,
  cx,
} from "../components/ui";
import { Logo } from "../components/Logo";
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconExternal,
  IconFund,
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
  const [tokenTotals, setTokenTotals] = useState<TokenScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [sendTarget, setSendTarget] = useState<Wallet | null>(null);
  const [version, setVersion] = useState("");
  // Kept in state so the array identity is stable — an inline literal would
  // re-trigger the dialogs' preview effects on every render.
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

  const noWallets = wallets.length === 0;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-600 bg-ink-850 px-2.5 py-1.5">
        <div className="flex items-center gap-2">
          <Logo size={18} />
          <span className="text-xs font-semibold tracking-tight">LocalWallet</span>
        </div>

        <div className="relative ml-1 min-w-44 flex-1 sm:max-w-64">
          <Input
            ref={searchRef}
            className="pr-14 pl-6"
            placeholder="Search label or address"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-mist-500">
            ⌕
          </span>
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

        <Toolbar className="ml-auto">
          {/* Data actions */}
          <ButtonGroup>
            <Button onClick={() => setDialog("import")}>Import</Button>
            <Button onClick={refreshBalances} disabled={refreshing || noWallets}>
              {refreshing && <Spinner />} Balances
            </Button>
            <Button onClick={scanTokens} disabled={scanning || noWallets}>
              {scanning && <Spinner />} Scan
            </Button>
          </ButtonGroup>

          {/* Actions that move funds */}
          <ButtonGroup>
            <Button
              onClick={() => {
                setCleanupScope({});
                setDialog("cleanup");
              }}
              disabled={noWallets}
            >
              Close
            </Button>
            <Button
              onClick={() => {
                setFundScope({});
                setDialog("funded-cleanup");
              }}
              disabled={noWallets}
              title="Lend each empty wallet a fee, close its token accounts, then send the proceeds to the sweep destination"
            >
              Fund &amp; close
            </Button>
          </ButtonGroup>

          <Button variant="primary" onClick={() => setDialog("sweep")} disabled={noWallets}>
            Collect all SOL
          </Button>

          <Button onClick={onOpenStake}>Stake</Button>

          <span className="mx-0.5 h-4 w-px bg-ink-600" />
          <Button variant="ghost" onClick={onOpenSettings}>
            Settings
          </Button>
          <Button variant="ghost" onClick={onLock}>
            Lock
          </Button>
        </Toolbar>
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
                <Th className="border-l border-ink-600">Address</Th>
                <Th numeric className="w-32 border-l border-ink-600">
                  SOL
                </Th>
                <Th className="w-28 border-l border-ink-600">Tokens</Th>
                <Th className="w-44 border-l border-ink-600" />
              </tr>
            </thead>
            <tbody>
              {visible.map((w) => {
                const walletTokens = tokens[w.pubkey];
                const isOpen = expanded === w.pubkey;
                const isFunder = settings.funder_pubkey === w.pubkey;
                // A wallet holding rent it cannot pay to release is exactly
                // what the funded flow exists for.
                const hasRent = (walletTokens?.reclaimable_lamports ?? 0) > 0;
                const canPay = (balances[w.pubkey] ?? 0) >= FEE_FLOOR_LAMPORTS;
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

                      <Td className="border-l border-ink-600/60">
                        <button
                          className="group/copy -mx-1 inline-flex max-w-full items-center gap-1.5 px-1 font-mono text-[11px] text-mist-300 outline-none hover:bg-ink-700 hover:text-mist-50 focus-visible:ring-1 focus-visible:ring-brand-500"
                          title={`${w.pubkey}\nClick to copy`}
                          onClick={() => copyAddress(w.pubkey)}
                        >
                          <span className="truncate">{shortKey(w.pubkey)}</span>
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

                      <Td numeric className="border-l border-ink-600/60 font-mono">
                        {balances[w.pubkey] === undefined && refreshing ? (
                          <Skeleton className="ml-auto h-3 w-14" />
                        ) : (
                          toSol(balances[w.pubkey])
                        )}
                      </Td>

                      <Td className="border-l border-ink-600/60">
                        {scanning && !walletTokens ? (
                          <Skeleton className="h-3 w-10" />
                        ) : walletTokens ? (
                          <button
                            className={cx(
                              "-mx-1 px-1 text-[11px] outline-none transition-colors",
                              "hover:bg-ink-700 focus-visible:ring-1 focus-visible:ring-brand-500",
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
                          <span className="text-[11px] text-mist-500">—</span>
                        )}
                      </Td>

                      <Td className="border-l border-ink-600/60">
                        <RowActions>
                          <IconButton
                            label="Send SOL"
                            tone="brand"
                            onClick={() => {
                              setSendTarget(w);
                              setDialog("send");
                            }}
                          >
                            <IconSend />
                          </IconButton>

                          {/* A wallet that can pay its own fee closes directly;
                              one that cannot has to be funded first. Only one
                              of the two ever shows, so the cluster keeps a
                              fixed width across rows. */}
                          {hasRent &&
                            (canPay ? (
                              <IconButton
                                label={`Close ${walletTokens.empty_accounts} empty token account${
                                  walletTokens.empty_accounts === 1 ? "" : "s"
                                } and reclaim ${toSol(walletTokens.reclaimable_lamports)} SOL`}
                                tone="brand"
                                onClick={() => {
                                  setCleanupScope({ pubkeys: [w.pubkey], label: w.label });
                                  setDialog("cleanup");
                                }}
                              >
                                <IconClose />
                              </IconButton>
                            ) : (
                              <IconButton
                                label={
                                  isFunder
                                    ? "The funding wallet cannot fund itself"
                                    : `Too empty to pay a fee — lend it one, close its accounts and reclaim ${toSol(
                                        walletTokens.reclaimable_lamports,
                                      )} SOL`
                                }
                                tone="cyan"
                                disabled={isFunder}
                                onClick={() => {
                                  setFundScope({ pubkeys: [w.pubkey], label: w.label });
                                  setDialog("funded-cleanup");
                                }}
                              >
                                <IconFund />
                              </IconButton>
                            ))}
                          {!hasRent && <span className="size-6" aria-hidden="true" />}

                          <IconButton
                            label={
                              isFunder
                                ? "This is the funding wallet — click to unset"
                                : "Use this wallet to fund fees for the others"
                            }
                            tone={isFunder ? "brand" : undefined}
                            onClick={() => setFunder(isFunder ? null : w.pubkey)}
                          >
                            <IconStar filled={isFunder} />
                          </IconButton>

                          <IconButton
                            label="Open in explorer"
                            onClick={() => openUrl(addressUrl(settings, w.pubkey))}
                          >
                            <IconExternal />
                          </IconButton>

                          <span className="mx-0.5 h-4 w-px self-center bg-ink-600" />

                          <IconButton label="Remove from vault" tone="danger" onClick={() => remove(w)}>
                            <IconTrash />
                          </IconButton>
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
      </div>

      {/* Status bar — the numbers that used to sit in a band of cards above the
          table, now permanently visible at a fraction of the space. */}
      <StatusBar>
        <StatusItem value={query ? `${visible.length}/${wallets.length}` : wallets.length} label="wallets" />
        <StatusDivider />
        <StatusItem value={`${toSol(total)} SOL`} tone="brand" />
        <StatusItem value={`${funded} funded`} />
        <StatusDivider />
        {tokenTotals ? (
          <>
            <StatusItem value={tokenTotals.total_accounts} label="token accts" tone="cyan" />
            <StatusItem value={`${toSol(tokenTotals.total_reclaimable_lamports)} reclaimable`} />
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
