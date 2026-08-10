import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal } from "./Modal";
import {
  Banner,
  Button,
  EmptyState,
  Field,
  LogBox,
  ProgressBar,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  cx,
} from "./ui";
import {
  api,
  asAppError,
  onFundedCleanupProgress,
  shortKey,
  toSol,
  type FundedCleanupPlan,
  type FundedCleanupProgress,
  type Settings,
  type Wallet,
} from "../lib/api";
import { txUrl } from "../lib/explorer";

type Phase = "choose" | "loading" | "preview" | "running" | "done";

const STAGE_TONE: Record<string, string> = {
  funding: "text-cyan-brand",
  closing: "text-purple-brand",
  returning: "text-brand-300",
  done: "text-brand-500",
  skipped: "text-mist-500",
  failed: "text-rose-400",
};

export function FundedCleanupDialog({
  settings,
  wallets,
  balances,
  onClose,
  onFinished,
  onOpenSettings,
  /** Restricts the run to these wallets. Undefined means every wallet. */
  pubkeys,
  scopeLabel,
}: {
  settings: Settings;
  wallets: Wallet[];
  balances: Record<string, number | null>;
  onClose: () => void;
  onFinished: () => void;
  onOpenSettings: () => void;
  pubkeys?: string[];
  scopeLabel?: string;
}) {
  // Default to the wallet best able to lend, which is almost always the one
  // the user would have picked by hand.
  const richest = useMemo(
    () =>
      [...wallets].sort((a, b) => (balances[b.pubkey] ?? 0) - (balances[a.pubkey] ?? 0))[0]?.pubkey ??
      "",
    [wallets, balances],
  );
  const [funder, setFunder] = useState(settings.funder_pubkey ?? richest);
  const [phase, setPhase] = useState<Phase>("choose");
  const [plan, setPlan] = useState<FundedCleanupPlan | null>(null);
  const [log, setLog] = useState<FundedCleanupProgress[]>([]);
  const [error, setError] = useState<string | null>(null);

  const destination = settings.destination_pubkey?.trim() ?? "";

  useEffect(() => {
    const unlisten = onFundedCleanupProgress((p) => setLog((prev) => [...prev, p]));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function loadPreview() {
    setPhase("loading");
    setError(null);
    try {
      setPlan(await api.fundedCleanupPreview(funder, pubkeys));
      setPhase("preview");
    } catch (e) {
      setError(asAppError(e).message);
      setPhase("choose");
    }
  }

  async function run() {
    setPhase("running");
    setError(null);
    setLog([]);
    try {
      await api.fundedCleanupRun(funder, pubkeys);
      setPhase("done");
      onFinished();
    } catch (e) {
      setError(asAppError(e).message);
      setPhase("done");
    }
  }

  // Only the latest line per wallet, so a three-stage wallet occupies one row.
  const latest = useMemo(() => {
    const byWallet = new Map<string, FundedCleanupProgress>();
    for (const entry of log) byWallet.set(entry.pubkey, entry);
    return [...byWallet.values()];
  }, [log]);

  const last = log[log.length - 1];
  const funded = latest.reduce((sum, l) => sum + l.funded_lamports, 0);
  const returned = latest.reduce((sum, l) => sum + l.returned_lamports, 0);
  const closed = latest.reduce((sum, l) => sum + l.accounts_closed, 0);
  const eligible = plan?.eligible ?? 0;

  return (
    <Modal
      title={
        scopeLabel ? (
          <span>
            Fund, close and return — <span className="text-brand-500">{scopeLabel}</span>
          </span>
        ) : (
          "Fund, close and return"
        )
      }
      onClose={onClose}
      busy={phase === "running"}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose} disabled={phase === "running"}>
            {phase === "done" ? "Close" : "Cancel"}
          </Button>
          {phase === "choose" && (
            <Button variant="primary" onClick={loadPreview} disabled={!funder || !destination}>
              Preview
            </Button>
          )}
          {(phase === "preview" || phase === "running") && (
            <Button
              variant="primary"
              onClick={run}
              disabled={phase === "running" || eligible === 0 || plan?.underfunded}
            >
              {phase === "running" && <Spinner />}
              {phase === "running"
                ? "Running…"
                : `Rescue ${eligible} wallet${eligible === 1 ? "" : "s"}`}
            </Button>
          )}
        </>
      }
    >
      {error && <Banner kind="error">{error}</Banner>}

      {!destination ? (
        <EmptyState title="No sweep destination set">
          <p className="mb-4">
            Reclaimed SOL is sent to the sweep destination. Set one in Settings first.
          </p>
          <Button onClick={onOpenSettings}>Open Settings</Button>
        </EmptyState>
      ) : (
        <>
          {(phase === "choose" || phase === "loading") && (
            <>
              <Banner kind="info">
                Wallets with no SOL cannot pay to close their own token accounts. This lends each
                one enough SOL from the funder, closes the accounts, then sends everything to the
                sweep destination. The loan is about 0.00095 SOL per wallet — the minimum balance Solana lets an
                account hold, plus the fees it will spend — and every account closed releases
                0.00204 SOL.
              </Banner>

              <Field
                label="Funding wallet"
                hint="Signs the loan for each wallet. It needs enough SOL to cover them all."
              >
                <Select value={funder} onChange={(e) => setFunder(e.target.value)}>
                  {wallets
                    .filter((w) => !pubkeys?.includes(w.pubkey))
                    .map((w) => (
                      <option key={w.pubkey} value={w.pubkey}>
                        {w.label} — {toSol(balances[w.pubkey])} SOL
                      </option>
                    ))}
                </Select>
              </Field>

              <Field
                label="Destination (from Settings)"
                hint="Shown in full on purpose — check every character before funding a run."
              >
                <div className="border border-ink-600 bg-ink-950 px-2 py-1 font-mono text-[11px] break-all text-mist-300">
                  {destination}
                </div>
              </Field>

              {phase === "loading" && (
                <EmptyState>
                  <Spinner className="mr-2" /> Scanning wallets and pricing fees…
                </EmptyState>
              )}
            </>
          )}

          {phase === "preview" && plan && (
            <>
              {plan.underfunded && (
                <Banner kind="error">
                  {plan.funder_label} holds {toSol(plan.funder_balance)} SOL but needs{" "}
                  {toSol(plan.total_funding)} SOL plus fees to fund every wallet. Top it up or pick
                  a different funder.
                </Banner>
              )}

              {!plan.returns_to_funder && eligible > 0 && (
                <Banner kind="warning">
                  Proceeds go to the sweep destination, not back to {plan.funder_label}. The funder
                  spends {toSol(plan.total_funding)} SOL and does not get it back — the destination
                  receives it along with the rent.
                </Banner>
              )}

              {eligible === 0 ? (
                <EmptyState title="Nothing to rescue">
                  No wallet needs funding to close its accounts.
                </EmptyState>
              ) : (
                <>
                  <div className="mb-3 grid grid-cols-2 gap-px border border-ink-600 bg-ink-600 sm:grid-cols-4">
                    <Figure label="Funder pays" value={toSol(plan.total_funding)} tone="rose" />
                    <Figure label="Rent recovered" value={toSol(plan.total_reclaimable)} tone="brand" />
                    <Figure label="Network fees" value={toSol(plan.total_fees)} />
                    <Figure
                      label="Destination gets"
                      value={toSol(plan.destination_receives)}
                      tone="brand"
                    />
                  </div>

                  <Table className="max-h-64 overflow-y-auto">
                    <thead>
                      <tr>
                        <Th>Wallet</Th>
                        <Th numeric>Accounts</Th>
                        <Th numeric>Balance</Th>
                        <Th numeric>Loan</Th>
                        <Th numeric>Rent</Th>
                        <Th>Note</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.items.map((item) => (
                        <Tr key={item.pubkey}>
                          <Td>
                            {item.label}{" "}
                            <span className="font-mono text-xs text-mist-500">
                              {shortKey(item.pubkey)}
                            </span>
                          </Td>
                          <Td numeric>{item.closable_accounts}</Td>
                          <Td numeric>{toSol(item.balance)}</Td>
                          <Td numeric className={item.skip_reason ? "text-mist-500" : undefined}>
                            {item.skip_reason ? "—" : toSol(item.funding_needed)}
                          </Td>
                          <Td numeric className={item.skip_reason ? "text-mist-500" : "text-brand-500"}>
                            {item.skip_reason ? "—" : toSol(item.reclaimable)}
                          </Td>
                          <Td className="text-xs text-mist-500">{item.skip_reason ?? ""}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>

                  <p className="mt-3 text-xs text-mist-500">
                    Each wallet takes three transactions: fund, close, return. The loan is returned
                    with the rent in the final step, so “funder pays” is capital tied up during the
                    run, not a cost. {plan.skipped} wallet{plan.skipped === 1 ? "" : "s"} skipped.
                  </p>
                </>
              )}
            </>
          )}

          {(phase === "running" || phase === "done") && (
            <>
              <Banner kind="info">
                {closed} account{closed === 1 ? "" : "s"} closed · {toSol(funded)} SOL lent ·{" "}
                {toSol(returned)} SOL returned to the destination.
              </Banner>
              <ProgressBar value={last ? (last.done / last.total) * 100 : 0} />
              <LogBox>
                {latest.length === 0 && <div className="py-0.5">Starting…</div>}
                {latest.map((entry) => (
                  <div key={entry.pubkey} className="flex items-baseline gap-2 py-0.5">
                    <span
                      className={cx(
                        "w-16 shrink-0 text-xs font-medium",
                        STAGE_TONE[entry.stage] ?? "text-mist-500",
                      )}
                    >
                      {entry.stage}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {entry.label} {shortKey(entry.pubkey)}
                      {entry.accounts_closed > 0 && ` — ${entry.accounts_closed} closed`}
                      {entry.returned_lamports > 0 && ` — ${toSol(entry.returned_lamports)} SOL back`}
                      {entry.error && ` — ${entry.error}`}
                    </span>
                    {entry.signatures.length > 0 && (
                      <button
                        className="shrink-0 text-brand-500 hover:underline"
                        onClick={() =>
                          openUrl(txUrl(settings, entry.signatures[entry.signatures.length - 1]))
                        }
                      >
                        tx ↗
                      </button>
                    )}
                  </div>
                ))}
              </LogBox>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "brand" | "rose";
}) {
  return (
    <div className="bg-ink-850 px-2.5 py-1.5">
      <div className="text-[10px] tracking-wider text-mist-500 uppercase">{label}</div>
      <div
        className={cx(
          "tnum mt-0.5 text-xs",
          tone === "brand" ? "text-brand-500" : tone === "rose" ? "text-rose-400" : "text-mist-50",
        )}
      >
        {value}
      </div>
    </div>
  );
}
