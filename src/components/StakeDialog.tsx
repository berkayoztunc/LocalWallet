import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal } from "./Modal";
import { Banner, Button, EmptyState, Field, Input, Spinner, cx } from "./ui";
import {
  LAMPORTS_PER_SOL,
  api,
  asAppError,
  shortKey,
  toSol,
  type Settings,
  type StakeQuote,
  type Validator,
  type Wallet,
} from "../lib/api";
import { txUrl } from "../lib/explorer";

type Phase = "form" | "confirm" | "sending" | "done";

export function StakeDialog({
  settings,
  wallet,
  onClose,
  onStaked,
}: {
  settings: Settings;
  wallet: Wallet;
  onClose: () => void;
  onStaked: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("form");
  const [quote, setQuote] = useState<StakeQuote | null>(null);
  const [validators, setValidators] = useState<Validator[] | null>(null);
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<Validator | null>(null);
  const [amount, setAmount] = useState("");
  const [useMax, setUseMax] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [stakeAddress, setStakeAddress] = useState<string | null>(null);

  // Quote and validator list load in parallel: neither depends on the other,
  // and the dialog is unusable without both.
  useEffect(() => {
    let active = true;
    api
      .stakeQuote(wallet.pubkey)
      .then((q) => active && setQuote(q))
      .catch((e) => active && setError(asAppError(e).message));
    api
      .validatorsList()
      .then((v) => active && setValidators(v.validators.filter((x) => !x.delinquent)))
      .catch((e) => active && setError(asAppError(e).message));
    return () => {
      active = false;
    };
  }, [wallet.pubkey]);

  const lamports = useMemo(() => {
    if (!quote) return 0;
    if (useMax) return quote.max_stakeable;
    const parsed = Number(amount);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * LAMPORTS_PER_SOL) : 0;
  }, [amount, useMax, quote]);

  const results = useMemo(() => {
    if (!validators) return [];
    const q = search.trim().toLowerCase();
    const matched = q
      ? validators.filter(
          (v) => (v.name ?? "").toLowerCase().includes(q) || v.vote_pubkey.toLowerCase().includes(q),
        )
      : validators;
    // The full list is ~700 entries; the picker only needs the top of it.
    return matched.slice(0, 40);
  }, [validators, search]);

  const belowMinimum = quote !== null && lamports > 0 && lamports < quote.minimum_delegation;
  const aboveMax = quote !== null && lamports > quote.max_stakeable;
  const canReview = !!chosen && lamports > 0 && !belowMinimum && !aboveMax;

  async function submit() {
    if (!chosen) return;
    setPhase("sending");
    setError(null);
    try {
      const result = await api.stakeDelegate(wallet.pubkey, chosen.vote_pubkey, lamports);
      if (result.status === "failed") {
        setError(result.error ?? "delegation failed");
        setPhase("confirm");
        return;
      }
      setSignature(result.signature);
      setStakeAddress(result.address);
      setPhase("done");
      onStaked();
    } catch (e) {
      setError(asAppError(e).message);
      setPhase("confirm");
    }
  }

  return (
    <Modal
      title={
        <span>
          Stake SOL from <span className="text-brand-500">{wallet.label}</span>
        </span>
      }
      onClose={onClose}
      busy={phase === "sending"}
      width="max-w-xl"
      footer={
        <>
          <span className="flex-1 font-mono text-[11px] text-mist-500">
            {quote && `${toSol(quote.max_stakeable)} SOL available to stake`}
          </span>
          <Button onClick={onClose} disabled={phase === "sending"}>
            {phase === "done" ? "Close" : "Cancel"}
          </Button>
          {phase === "form" && (
            <Button variant="primary" onClick={() => setPhase("confirm")} disabled={!canReview}>
              Review
            </Button>
          )}
          {(phase === "confirm" || phase === "sending") && (
            <Button variant="primary" onClick={submit} disabled={phase === "sending"}>
              {phase === "sending" && <Spinner />}
              {phase === "sending" ? "Staking…" : "Confirm and stake"}
            </Button>
          )}
        </>
      }
    >
      {error && <Banner kind="error">{error}</Banner>}

      {phase === "done" && signature && (
        <>
          <Banner kind="success">
            Staked {toSol(lamports)} SOL with {chosen?.name ?? shortKey(chosen?.vote_pubkey ?? "")}.
            It starts earning next epoch.
          </Banner>
          {stakeAddress && (
            <Field label="New stake account">
              <div className="border border-ink-600 bg-ink-950 px-2 py-1 font-mono text-[11px] break-all text-mist-300">
                {stakeAddress}
              </div>
            </Field>
          )}
          <Button variant="ghost" size="sm" onClick={() => openUrl(txUrl(settings, signature))}>
            View transaction ↗
          </Button>
        </>
      )}

      {phase === "form" && (
        <>
          {!quote ? (
            <EmptyState>
              <Spinner className="mr-2" /> Reading balance and network minimums…
            </EmptyState>
          ) : quote.max_stakeable < quote.minimum_delegation ? (
            <EmptyState title="Not enough SOL to stake">
              <p>
                This wallet holds {toSol(quote.balance)} SOL. After the{" "}
                {toSol(quote.rent)} SOL rent reserve for the stake account, the fee, and the
                wallet&rsquo;s own rent-exempt minimum, there is less than the{" "}
                {toSol(quote.minimum_delegation)} SOL network minimum left to delegate.
              </p>
            </EmptyState>
          ) : (
            <>
              <Field
                label="Validator"
                hint={
                  validators
                    ? "Sorted by stake. Commission is what the validator keeps from your rewards."
                    : "Loading validators…"
                }
              >
                {chosen ? (
                  <div className="flex items-center gap-2 border border-ink-500 bg-ink-950 px-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {chosen.name ?? (
                        <span className="font-mono">{shortKey(chosen.vote_pubkey)}</span>
                      )}
                      <span className="ml-2 text-mist-500">
                        {chosen.commission}% commission
                        {chosen.apy != null && ` · ~${chosen.apy.toFixed(2)}% APY`}
                      </span>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setChosen(null)}>
                      Change
                    </Button>
                  </div>
                ) : (
                  <>
                    <Input
                      autoFocus
                      placeholder="Search by name or vote address"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <div className="mt-1 max-h-48 overflow-auto border border-ink-600 bg-ink-950">
                      {!validators ? (
                        <div className="p-3 text-center text-[11px] text-mist-500">
                          <Spinner className="mr-1.5" /> Loading…
                        </div>
                      ) : results.length === 0 ? (
                        <div className="p-3 text-center text-[11px] text-mist-500">
                          No validator matches “{search}”.
                        </div>
                      ) : (
                        results.map((v) => (
                          <button
                            key={v.vote_pubkey}
                            onClick={() => setChosen(v)}
                            className="flex w-full items-center gap-2 border-b border-ink-800 px-2 py-1 text-left text-[11px] outline-none last:border-0 hover:bg-ink-800 focus-visible:bg-ink-800"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {v.name ?? (
                                <span className="font-mono">{shortKey(v.vote_pubkey)}</span>
                              )}
                            </span>
                            <span className="tnum shrink-0 text-mist-500">{v.commission}%</span>
                            <span className="tnum w-14 shrink-0 text-right text-brand-500">
                              {v.apy != null ? `${v.apy.toFixed(1)}%` : "—"}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </>
                )}
              </Field>

              <Field
                label="Amount (SOL)"
                error={
                  belowMinimum
                    ? `The network minimum delegation is ${toSol(quote.minimum_delegation)} SOL`
                    : aboveMax
                      ? `This wallet can stake at most ${toSol(quote.max_stakeable)} SOL`
                      : undefined
                }
                hint={`A further ${toSol(quote.rent)} SOL is locked as the stake account's rent reserve. You get it back when you withdraw.`}
              >
                <div className="flex gap-2">
                  <Input
                    type="number"
                    step="0.000000001"
                    min="0"
                    placeholder="0.0"
                    value={useMax ? toSol(quote.max_stakeable) : amount}
                    disabled={useMax}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <Button
                    variant={useMax ? "primary" : "secondary"}
                    onClick={() => setUseMax((v) => !v)}
                  >
                    Max
                  </Button>
                </div>
              </Field>
            </>
          )}
        </>
      )}

      {(phase === "confirm" || phase === "sending") && quote && chosen && (
        <>
          <Banner kind="warning">
            Staked SOL cannot be spent until you unstake it, which takes a cooldown of roughly two
            to three days. It starts earning from the next epoch, not immediately.
          </Banner>

          <div className="border border-ink-600 bg-ink-950 p-2 font-mono text-[11px]">
            <Row label="Delegating" value={`${toSol(lamports)} SOL`} strong />
            <Row label="Rent reserve" value={`${toSol(quote.rent)} SOL`} />
            <Row label="Network fee" value={`${toSol(quote.fee)} SOL`} />
            <Row
              label="Leaves wallet"
              value={`${toSol(quote.balance - lamports - quote.rent - quote.fee)} SOL`}
            />
            <div className="mt-2 border-t border-ink-600 pt-2">
              <div className="mb-1 text-mist-500">Validator</div>
              <div className="break-all text-mist-50">
                {chosen.name ? `${chosen.name} — ` : ""}
                {chosen.vote_pubkey}
              </div>
              <div className="mt-1 text-mist-500">
                {chosen.commission}% commission
                {chosen.apy != null && ` · ~${chosen.apy.toFixed(2)}% estimated APY`}
              </div>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-mist-500">{label}</span>
      <span className={cx(strong ? "text-brand-500" : "text-mist-50")}>{value}</span>
    </div>
  );
}
