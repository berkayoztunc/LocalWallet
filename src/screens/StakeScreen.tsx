import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  asAppError,
  shortKey,
  toSol,
  type Settings,
  type StakeAccount,
  type StakeProgress,
  type StakeScan,
  type StakeStatus,
  type ValidatorList,
} from "../lib/api";
import { addressUrl } from "../lib/explorer";
import {
  Banner,
  Button,
  EmptyState,
  IconButton,
  Input,
  LogBox,
  SegmentedControl,
  Skeleton,
  Spinner,
  StatusBar,
  StatusDivider,
  StatusItem,
  Table,
  Td,
  Th,
  Tr,
  cx,
} from "../components/ui";
import { IconExternal, IconUnstake, IconWithdraw } from "../components/icons";
import { Logo } from "../components/Logo";

type Tab = "stakes" | "validators";

/** Status dot colours, mirroring the lifecycle order. */
const STATUS_TONE: Record<StakeStatus, string> = {
  active: "text-brand-500",
  activating: "text-cyan-brand",
  deactivating: "text-amber-warn",
  inactive: "text-mist-500",
};

function StatusDot({ status }: { status: StakeStatus }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5", STATUS_TONE[status])}>
      <span className="text-[8px] leading-none">●</span>
      {status}
    </span>
  );
}

export function StakeScreen({
  settings,
  onBack,
}: {
  settings: Settings;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<Tab>("stakes");
  const [scan, setScan] = useState<StakeScan | null>(null);
  const [validators, setValidators] = useState<ValidatorList | null>(null);
  const [scanning, setScanning] = useState(false);
  const [loadingValidators, setLoadingValidators] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<StakeProgress[]>([]);
  const [query, setQuery] = useState("");
  const [hideDelinquent, setHideDelinquent] = useState(true);

  const scanStakes = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      setScan(await api.stakeScan());
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setScanning(false);
    }
  }, []);

  const loadValidators = useCallback(async () => {
    setLoadingValidators(true);
    setError(null);
    try {
      setValidators(await api.validatorsList());
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setLoadingValidators(false);
    }
  }, []);

  useEffect(() => {
    scanStakes();
  }, [scanStakes]);

  // The validator list is ~0.3 MB from the RPC plus an optional directory
  // fetch, so it loads when the tab is first opened rather than on mount.
  useEffect(() => {
    if (tab === "validators" && !validators && !loadingValidators) loadValidators();
  }, [tab, validators, loadingValidators, loadValidators]);

  async function deactivate(account: StakeAccount) {
    const ok = window.confirm(
      `Deactivate this stake?\n\n${toSol(account.lamports)} SOL delegated from "${account.owner_label}".\n\nIt stops earning immediately and takes until the end of the next epoch (roughly 2-3 days) to become withdrawable.`,
    );
    if (!ok) return;
    setBusy(account.address);
    setError(null);
    try {
      const [result] = await api.stakeDeactivate([[account.owner_pubkey, account.address]]);
      setLog((prev) => [...prev, result]);
      await scanStakes();
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  }

  async function withdraw(account: StakeAccount) {
    setBusy(account.address);
    setError(null);
    try {
      // No destination: the stake returns to the wallet that owns it. Sending
      // it elsewhere should be a deliberate, separate step.
      const result = await api.stakeWithdraw(account.owner_pubkey, account.address);
      setLog((prev) => [...prev, result]);
      if (result.status === "failed") setError(result.error ?? "withdraw failed");
      await scanStakes();
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(null);
    }
  }

  const visibleValidators = useMemo(() => {
    if (!validators) return [];
    const q = query.trim().toLowerCase();
    return validators.validators.filter((v) => {
      if (hideDelinquent && v.delinquent) return false;
      if (!q) return true;
      return (
        v.vote_pubkey.toLowerCase().includes(q) ||
        (v.name ?? "").toLowerCase().includes(q) ||
        v.node_pubkey.toLowerCase().includes(q)
      );
    });
  }, [validators, query, hideDelinquent]);

  /** Vote address → display name, so stake rows can show a validator name. */
  const nameByVote = useMemo(() => {
    const map = new Map<string, string>();
    validators?.validators.forEach((v) => {
      if (v.name) map.set(v.vote_pubkey, v.name);
    });
    return map;
  }, [validators]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-ink-600 bg-ink-850 px-2.5 py-1.5">
        <Logo size={18} />
        <span className="text-xs font-semibold tracking-tight">Stake</span>

        <div className="ml-3 w-56">
          <SegmentedControl
            value={tab}
            onChange={(v) => setTab(v)}
            options={[
              { value: "stakes" as Tab, label: "My stakes" },
              { value: "validators" as Tab, label: "Validators" },
            ]}
          />
        </div>

        <span className="flex-1" />

        {tab === "stakes" ? (
          <Button onClick={scanStakes} disabled={scanning}>
            {scanning && <Spinner />} Rescan
          </Button>
        ) : (
          <Button onClick={loadValidators} disabled={loadingValidators}>
            {loadingValidators && <Spinner />} Reload
          </Button>
        )}
        <Button variant="ghost" onClick={onBack}>
          ← Back to wallets
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-2.5">
        {error && <Banner kind="error">{error}</Banner>}

        {scan && scan.errors.length > 0 && (
          <Banner kind="warning">
            {scan.errors.length} wallet{scan.errors.length === 1 ? "" : "s"} could not be scanned,
            so this list may be incomplete: {scan.errors[0]}
          </Banner>
        )}

        {/* ------------------------------ My stakes --------------------------- */}
        {tab === "stakes" &&
          (scanning && !scan ? (
            <EmptyState>
              <Spinner className="mr-2" /> Scanning wallets for stake accounts…
            </EmptyState>
          ) : !scan || scan.accounts.length === 0 ? (
            <EmptyState title="No stake accounts">
              None of your wallets control a stake account.
            </EmptyState>
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th className="w-[18%]">Wallet</Th>
                    <Th className="border-l border-ink-600">Validator</Th>
                    <Th numeric className="w-32 border-l border-ink-600">
                      Stake
                    </Th>
                    <Th className="w-28 border-l border-ink-600">Status</Th>
                    <Th numeric className="w-20 border-l border-ink-600">
                      Epoch
                    </Th>
                    <Th className="w-24 border-l border-ink-600" />
                  </tr>
                </thead>
                <tbody>
                  {scan.accounts.map((a) => {
                    const name = a.vote_account ? nameByVote.get(a.vote_account) : undefined;
                    const working = busy === a.address;
                    return (
                      <Tr key={a.address}>
                        <Td className="truncate">{a.owner_label}</Td>
                        <Td className="border-l border-ink-600/60 font-mono text-[11px]">
                          {a.vote_account ? (
                            <span title={a.vote_account}>
                              {name ?? shortKey(a.vote_account)}
                            </span>
                          ) : (
                            <span className="text-mist-500">undelegated</span>
                          )}
                        </Td>
                        <Td numeric className="border-l border-ink-600/60 font-mono">
                          {toSol(a.lamports)}
                        </Td>
                        <Td className="border-l border-ink-600/60 text-[11px]">
                          <StatusDot status={a.status} />
                        </Td>
                        <Td numeric className="border-l border-ink-600/60 text-[11px] text-mist-500">
                          {a.deactivation_epoch ?? a.activation_epoch}
                        </Td>
                        <Td className="border-l border-ink-600/60">
                          <div className="flex justify-end gap-px">
                            {working ? (
                              <span className="grid size-6 place-items-center">
                                <Spinner />
                              </span>
                            ) : (
                              <>
                                <IconButton
                                  label={
                                    !a.can_deactivate
                                      ? a.status === "inactive"
                                        ? "Already inactive"
                                        : "This vault does not hold the stake authority"
                                      : `Deactivate ${toSol(a.lamports)} SOL — starts a 2-3 day cooldown`
                                  }
                                  tone="brand"
                                  disabled={!a.can_deactivate}
                                  onClick={() => deactivate(a)}
                                >
                                  <IconUnstake />
                                </IconButton>
                                <IconButton
                                  label={
                                    a.can_withdraw
                                      ? `Withdraw ${toSol(a.lamports)} SOL back to ${a.owner_label}`
                                      : a.status === "deactivating"
                                        ? `Still cooling down — withdrawable once epoch ${a.deactivation_epoch} ends`
                                        : a.status === "inactive"
                                          ? "This vault does not hold the withdraw authority"
                                          : "Deactivate it first, then withdraw after the cooldown"
                                  }
                                  tone="cyan"
                                  disabled={!a.can_withdraw}
                                  onClick={() => withdraw(a)}
                                >
                                  <IconWithdraw />
                                </IconButton>
                              </>
                            )}
                            <IconButton
                              label="Open stake account in explorer"
                              onClick={() => openUrl(addressUrl(settings, a.address))}
                            >
                              <IconExternal />
                            </IconButton>
                          </div>
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>

              {log.length > 0 && (
                <div className="mt-3">
                  <LogBox>
                    {log.map((entry, i) => (
                      <div key={i} className="flex items-baseline gap-2 py-0.5">
                        <span
                          className={cx(
                            "w-20 shrink-0 text-[11px] font-medium",
                            entry.status === "failed" ? "text-rose-400" : "text-brand-500",
                          )}
                        >
                          {entry.status}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {shortKey(entry.address)}
                          {entry.lamports > 0 && ` — ${toSol(entry.lamports)} SOL`}
                          {entry.error && ` — ${entry.error}`}
                        </span>
                      </div>
                    ))}
                  </LogBox>
                </div>
              )}
            </>
          ))}

        {/* ------------------------------ Validators -------------------------- */}
        {tab === "validators" && (
          <>
            <div className="mb-2 flex items-center gap-2">
              <Input
                className="max-w-72"
                placeholder="Search name or vote address"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <label className="flex items-center gap-1.5 text-[11px] text-mist-300">
                <input
                  type="checkbox"
                  className="accent-brand-500"
                  checked={hideDelinquent}
                  onChange={(e) => setHideDelinquent(e.target.checked)}
                />
                Hide delinquent
              </label>
              <span className="flex-1" />
              <span className="text-[11px] text-mist-500">
                {visibleValidators.length} shown
              </span>
            </div>

            {validators?.directory_error && (
              <Banner kind="warning">
                Validator names are unavailable — the directory did not respond
                ({validators.directory_error}). Numbers below still come from your RPC.
              </Banner>
            )}
            {validators && !validators.directory_used && !validators.directory_error && (
              <Banner kind="info">
                Validator names are off. Everything below comes from your RPC alone — enable the
                directory in Settings to see names and APY estimates.
              </Banner>
            )}

            {loadingValidators && !validators ? (
              <div className="space-y-1">
                {Array.from({ length: 12 }).map((_, i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            ) : visibleValidators.length === 0 ? (
              <EmptyState title="No validators match">
                <Button variant="ghost" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              </EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Validator</Th>
                    <Th numeric className="w-36 border-l border-ink-600">
                      Active stake
                    </Th>
                    <Th numeric className="w-20 border-l border-ink-600">
                      Comm.
                    </Th>
                    <Th numeric className="w-20 border-l border-ink-600">
                      APY
                    </Th>
                    <Th numeric className="w-24 border-l border-ink-600">
                      Credits
                    </Th>
                    <Th className="w-16 border-l border-ink-600" />
                  </tr>
                </thead>
                <tbody>
                  {visibleValidators.map((v) => (
                    <Tr key={v.vote_pubkey}>
                      <Td>
                        <div className="flex min-w-0 items-center gap-1.5">
                          {v.delinquent && (
                            <span className="text-[8px] leading-none text-rose-400">●</span>
                          )}
                          <span className="truncate" title={v.vote_pubkey}>
                            {v.name ?? (
                              <span className="font-mono text-[11px]">
                                {shortKey(v.vote_pubkey)}
                              </span>
                            )}
                          </span>
                        </div>
                      </Td>
                      <Td numeric className="border-l border-ink-600/60 font-mono">
                        {Math.round(v.activated_stake / 1e9).toLocaleString()}
                      </Td>
                      <Td numeric className="border-l border-ink-600/60">
                        {v.commission}%
                      </Td>
                      <Td numeric className="border-l border-ink-600/60 text-brand-500">
                        {v.apy != null ? `${v.apy.toFixed(2)}%` : "—"}
                      </Td>
                      <Td numeric className="border-l border-ink-600/60 text-mist-500">
                        {v.epoch_credits.toLocaleString()}
                      </Td>
                      <Td className="border-l border-ink-600/60">
                        <div className="flex justify-end">
                          <IconButton
                            label="Open vote account in explorer"
                            onClick={() => openUrl(addressUrl(settings, v.vote_pubkey))}
                          >
                            <IconExternal />
                          </IconButton>
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
      </div>

      <StatusBar>
        {scan ? (
          <>
            <StatusItem value={scan.accounts.length} label="stake accts" />
            <StatusDivider />
            <StatusItem value={`${toSol(scan.total_staked)} SOL`} tone="brand" />
            <StatusItem value={`${scan.active_count} active`} />
            {scan.total_withdrawable > 0 && (
              <>
                <StatusDivider />
                <StatusItem
                  value={`${toSol(scan.total_withdrawable)} withdrawable`}
                  tone="cyan"
                />
              </>
            )}
            <StatusDivider />
            <StatusItem value={scan.current_epoch} label="epoch" />
          </>
        ) : (
          <StatusItem value="not scanned" />
        )}
        <span className="flex-1" />
        {validators && (
          <StatusItem
            value={`${validators.validators.length - validators.delinquent_count} validators`}
          />
        )}
      </StatusBar>
    </div>
  );
}
