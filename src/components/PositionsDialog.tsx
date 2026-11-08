import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  asAppError,
  formatUnits,
  shortKey,
  toSol,
  type PositionsCache,
  type PumpView,
  type Settings,
  type StreamsView,
  type Wallet,
} from "../lib/api";
import { addressUrl } from "../lib/explorer";
import { Modal } from "./Modal";
import { Button, Input, SegmentedControl, Spinner } from "./ui";

/*
 * Fees & locks: a sheet (shared `Modal`) with a toolbar holding a segmented
 * control and search, an inset table, and a status bar.
 *
 * The table is wallet-centric: every vault wallet is a row with its own tools,
 * so a single wallet can be scanned, inspected or forgotten without driving
 * everything from the toolbar. Scans are incremental: "Scan outdated" skips
 * wallets checked recently, which is the main saving in RPC and API traffic.
 */

type Tab = "pump" | "streams";

/** How long a check stays fresh. Streamflow is slow, rate-limited and changes
 *  rarely; Pump.fun fees accrue with every trade. */
const FRESH_SECS: Record<Tab, number> = { pump: 5 * 60, streams: 6 * 3600 };

function ago(secs: number | undefined): string {
  if (!secs) return "Never";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  if (d < 60) return "Just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function fmtFull(secs: number | undefined): string {
  return secs ? new Date(secs * 1000).toLocaleString() : "Never";
}

/* ------------------------------ small pieces ------------------------------ */

function Dot({ at, fresh }: { at: number | undefined; fresh: number }) {
  const age = at ? Date.now() / 1000 - at : Infinity;
  const color = !at ? "bg-ink-400" : age < fresh ? "bg-ok" : "bg-amber-warn";
  return <span className={`inline-block size-1.5 rounded-full ${color}`} />;
}

/* -------------------------------- dialog --------------------------------- */

export function PositionsDialog({
  settings,
  wallets,
  onClose,
}: {
  settings: Settings;
  wallets: Wallet[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("pump");
  const [pump, setPump] = useState<PumpView | null>(null);
  const [streams, setStreams] = useState<StreamsView | null>(null);
  const [query, setQuery] = useState("");
  const [onlyWith, setOnlyWith] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  // Per wallet and tab, so one slow row never blocks the others.
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const [notice, setNotice] = useState<Record<Tab, string | null>>({ pump: null, streams: null });
  const [errors, setErrors] = useState<Record<Tab, string[]>>({ pump: [], streams: [] });

  const apply = (c: PositionsCache) => {
    setPump(c.pump);
    setStreams(c.streams);
  };

  useEffect(() => {
    let active = true;
    api
      .positionsLoad()
      .then((c) => active && apply(c))
      .catch((e) => active && setErrors((p) => ({ ...p, pump: [asAppError(e).message] })));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !bulk && working.size === 0) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bulk, working, onClose]);

  const checked = (tab === "pump" ? pump?.checked : streams?.checked) ?? {};
  const fresh = FRESH_SECS[tab];

  const pumpBy = useMemo(() => new Map(pump?.rows.map((r) => [r.owner_pubkey, r])), [pump]);
  const streamsBy = useMemo(() => {
    const m = new Map<string, NonNullable<typeof streams>["rows"]>();
    for (const r of streams?.rows ?? []) m.set(r.owner_pubkey, [...(m.get(r.owner_pubkey) ?? []), r]);
    return m;
  }, [streams]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return wallets.filter((w) => {
      if (q && !w.label.toLowerCase().includes(q) && !w.pubkey.toLowerCase().includes(q)) return false;
      if (onlyWith && !(tab === "pump" ? pumpBy.has(w.pubkey) : streamsBy.has(w.pubkey))) return false;
      return true;
    });
  }, [wallets, query, onlyWith, tab, pumpBy, streamsBy]);

  const outdated = wallets.filter((w) => {
    const t = checked[w.pubkey];
    return !t || Date.now() / 1000 - t >= fresh;
  }).length;

  /** One entry point for every scan: row, selection, outdated, or all. */
  async function scan(which: Tab, pubkeys: string[] | undefined, force: boolean, rowKey?: string) {
    const key = rowKey ? `${which}:${rowKey}` : null;
    if (key) setWorking((s) => new Set(s).add(key));
    else setBulk(true);
    setNotice((n) => ({ ...n, [which]: null }));
    try {
      const maxAge = force ? undefined : FRESH_SECS[which];
      if (which === "pump") {
        const v = await api.positionsScanPump(pubkeys, maxAge);
        setPump(v);
        setErrors((e) => ({ ...e, pump: v.errors }));
        if (v.skipped_fresh > 0)
          setNotice((n) => ({ ...n, pump: `Skipped ${v.skipped_fresh} recently checked wallet(s).` }));
      } else {
        const v = await api.positionsScanStreams(pubkeys, maxAge);
        setStreams(v);
        setErrors((e) => ({ ...e, streams: v.errors }));
        if (v.skipped_fresh > 0)
          setNotice((n) => ({ ...n, streams: `Skipped ${v.skipped_fresh} recently checked wallet(s).` }));
      }
    } catch (e) {
      setErrors((p) => ({ ...p, [which]: [asAppError(e).message] }));
    } finally {
      if (key)
        setWorking((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      else setBulk(false);
    }
  }

  async function forget(pubkeys: string[]) {
    try {
      apply(await api.positionsForget(tab, pubkeys));
      setSelected(new Set());
    } catch (e) {
      setErrors((p) => ({ ...p, [tab]: [asAppError(e).message] }));
    }
  }

  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
  const explorer = (a: string) => void openUrl(addressUrl(settings, a));

  const link = (address: string) => (
    <button
      className="font-mono text-brand-500 hover:underline"
      title={address}
      onClick={() => explorer(address)}
    >
      {shortKey(address, 4, 4)}
    </button>
  );

  const detail = (items: [string, ReactNode][]) => (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-[12px]">
      {items.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-mist-500">{k}</dt>
          <dd className="break-all text-mist-50">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );

  const allSelected = rows.length > 0 && rows.every((w) => selected.has(w.pubkey));
  const sel = [...selected];
  const lastScan = tab === "pump" ? pump?.last_scan_at : streams?.last_scan_at;
  const busyAny = bulk || working.size > 0;
  const colSpan = 5;

  const statusBar = (
    <div className="flex w-full items-center gap-3 text-[11px] text-mist-500">
          <span>
            {tab === "pump"
              ? `Total claimable ${toSol(pump?.total_lamports ?? 0)} SOL`
              : `${streams?.rows.length ?? 0} active lock(s)`}
          </span>
          <span>·</span>
          <span>
            {wallets.length - outdated} of {wallets.length} up to date
          </span>
          <span className="flex-1" />
          <span>Last scan: {fmtFull(lastScan ?? undefined)}</span>
        </div>
  );

  return (
    <Modal
      title="Creator Fees & Locks"
      onClose={onClose}
      busy={busyAny}
      width="max-w-5xl"
      footer={statusBar}
    >
        {/* Toolbar */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <SegmentedControl<Tab>
            className="max-w-[17rem]"
            value={tab}
            onChange={(t) => {
              setTab(t);
              setOpen(null);
              setSelected(new Set());
            }}
            options={[
              { value: "pump", label: "Pump.fun Fees" },
              { value: "streams", label: "Streamflow Locks" },
            ]}
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search wallets"
            aria-label="Search wallets"
            className="h-7 max-w-44"
          />
          <label className="flex items-center gap-1.5 text-xs text-mist-300">
            <input type="checkbox" checked={onlyWith} onChange={(e) => setOnlyWith(e.target.checked)} />
            Only with results
          </label>

          <span className="flex-1" />
          <Button
            variant="primary"
            disabled={busyAny || wallets.length === 0 || outdated === 0}
            onClick={() => void scan(tab, undefined, false)}
            title="Scan only wallets that have not been checked recently"
          >
            {bulk ? <Spinner /> : null}
            Scan Outdated{outdated > 0 ? ` (${outdated})` : ""}
          </Button>
          <Button
            disabled={busyAny || wallets.length === 0}
            onClick={() => void scan(tab, undefined, true)}
            title="Check every wallet again, even recently checked ones"
          >
            Rescan All
          </Button>
        </div>

        {/* Messages */}
        <div className="mb-2">
          <p className="text-[11px] leading-snug text-mist-500">
            {tab === "pump"
              ? "Read-only. Reads Pump.fun creator vaults through your RPC; nothing leaves your machine."
              : "Read-only. Wallets with a Streamflow contract are looked up through Streamflow's public API, which sends those addresses to api-public.streamflow.finance. It rate-limits hard, so scans are slow and stop when limited."}
          </p>
          {notice[tab] && <p className="mt-1 text-[11px] text-mist-500">{notice[tab]}</p>}
          {errors[tab].length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-warn/30 bg-amber-warn/10 px-3 py-2 text-[12px] text-amber-warn">
              Some lookups failed; results already saved are kept.
              <ul className="mt-1 list-disc pl-4 break-all">
                {errors[tab].slice(0, 4).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
                {errors[tab].length > 4 && <li>…and {errors[tab].length - 4} more</li>}
              </ul>
            </div>
          )}
        </div>

        {/* Selection bar */}
        {sel.length > 0 && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-brand-500/15 px-3 py-1.5 text-xs">
            <span className="font-medium">{sel.length} selected</span>
            <span className="flex-1" />
            <Button size="sm" disabled={busyAny} onClick={() => void scan(tab, sel, true)}>
              Scan Selected
            </Button>
            <Button size="sm" disabled={busyAny} onClick={() => void forget(sel)}>
              Forget Selected
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}

        {/* Table */}
        <div>
          {wallets.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-mist-500">No wallets in the vault.</p>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-mist-500">No wallets match.</p>
          ) : (
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="text-left text-[11px] text-mist-500">
                  <th className="sticky top-0 w-7 border-b border-white/10 bg-ink-850 py-1.5 pl-1 font-medium">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(allSelected ? new Set() : new Set(rows.map((w) => w.pubkey)))
                      }
                    />
                  </th>
                  <th className="sticky top-0 border-b border-white/10 bg-ink-850 py-1.5 font-medium">
                    Wallet
                  </th>
                  <th className="sticky top-0 border-b border-white/10 bg-ink-850 py-1.5 text-right font-medium">
                    {tab === "pump" ? "Claimable (SOL)" : "Active Locks"}
                  </th>
                  <th className="sticky top-0 border-b border-white/10 bg-ink-850 py-1.5 pl-4 font-medium">
                    Checked
                  </th>
                  <th className="sticky top-0 border-b border-white/10 bg-ink-850 py-1.5 pr-1 text-right font-medium">
                    Tools
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => {
                  const f = pumpBy.get(w.pubkey);
                  const ss = streamsBy.get(w.pubkey) ?? [];
                  const busy = working.has(`${tab}:${w.pubkey}`);
                  const isOpen = open === w.pubkey;
                  const hasDetail = tab === "pump" ? !!f : ss.length > 0;
                  return (
                    <Fragment key={w.pubkey}>
                      <tr className="border-b border-white/5 hover:bg-white/[0.04]">
                        <td className="py-1.5 pl-1">
                          <input
                            type="checkbox"
                            aria-label={`Select ${w.label}`}
                            checked={selected.has(w.pubkey)}
                            onChange={() =>
                              setSelected((s) => {
                                const n = new Set(s);
                                if (!n.delete(w.pubkey)) n.add(w.pubkey);
                                return n;
                              })
                            }
                          />
                        </td>
                        <td className="py-1.5">
                          <div className="font-medium">{w.label}</div>
                          <div className="font-mono text-[11px] text-mist-500">
                            {shortKey(w.pubkey, 6, 6)}
                          </div>
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {tab === "pump" ? (
                            f ? (
                              toSol(f.sol_lamports + f.amm_lamports)
                            ) : (
                              <span className="text-ink-400">—</span>
                            )
                          ) : ss.length > 0 ? (
                            `${ss.length} lock${ss.length > 1 ? "s" : ""}`
                          ) : (
                            <span className="text-ink-400">—</span>
                          )}
                        </td>
                        <td className="py-1.5 pl-4 whitespace-nowrap text-mist-500">
                          <span className="inline-flex items-center gap-1.5" title={fmtFull(checked[w.pubkey])}>
                            <Dot at={checked[w.pubkey]} fresh={fresh} />
                            {ago(checked[w.pubkey])}
                          </span>
                        </td>
                        <td className="py-1.5 pr-1 text-right whitespace-nowrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy || bulk}
                            onClick={() => void scan(tab, [w.pubkey], true, w.pubkey)}
                            title="Check this wallet now"
                          >
                            {busy ? <Spinner /> : "Scan"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!hasDetail}
                            onClick={() => setOpen(isOpen ? null : w.pubkey)}
                            title={hasDetail ? "Show the saved result" : "Nothing saved for this wallet"}
                          >
                            {isOpen ? "Hide" : "Details"}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => copy(w.pubkey)} title="Copy address">
                            Copy
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => explorer(w.pubkey)} title="Open in explorer">
                            Open
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!checked[w.pubkey]}
                            onClick={() => void forget([w.pubkey])}
                            title="Forget the saved result for this wallet"
                          >
                            Forget
                          </Button>
                        </td>
                      </tr>
                      {isOpen && hasDetail && (
                        <tr className="border-b border-white/5">
                          <td colSpan={colSpan} className="bg-white/[0.03] px-4 py-2.5">
                            {tab === "pump" && f ? (
                              detail([
                                ["Scanned", fmtFull(f.scanned_at)],
                                ["Bonding-curve vault", link(f.vault)],
                                ["Bonding curve", `${toSol(f.sol_lamports)} SOL`],
                                ["AMM vault (WSOL account)", link(f.amm_vault)],
                                ["AMM", `${toSol(f.amm_lamports)} SOL`],
                              ])
                            ) : (
                              <div className="space-y-3">
                                {ss.map((s) => (
                                  <div key={s.address} className="border-l-2 border-brand-500/60 pl-3">
                                    {detail([
                                      ["Scanned", fmtFull(s.scanned_at)],
                                      [
                                        "Type",
                                        s.contract_type.replace(/_/g, " ").toLowerCase() +
                                          (s.paused ? " (paused)" : ""),
                                      ],
                                      ["Contract", link(s.address)],
                                      ["Token", link(s.mint)],
                                      ["Sender", link(s.sender)],
                                      ["Total", formatUnits(s.total, s.decimals)],
                                      ["Claimed", formatUnits(s.claimed, s.decimals)],
                                      ["Locked", formatUnits(s.locked, s.decimals)],
                                      [
                                        "Claimable now",
                                        s.withdrawable ? formatUnits(s.withdrawable, s.decimals) : "—",
                                      ],
                                      ["Ends", fmtDate(s.end)],
                                    ])}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
    </Modal>
  );
}
