import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal } from "./Modal";
import { Banner, Button, Field, Input, SegmentedControl, Select, Spinner } from "./ui";
import {
  LAMPORTS_PER_SOL,
  api,
  asAppError,
  shortKey,
  toSol,
  type Settings,
  type Wallet,
} from "../lib/api";
import {
  openPrivacySession,
  privateBalance,
  privateSend,
  quotePrivateSend,
  quoteShield,
  shield,
  type PrivacyQuote,
  type PrivacySession,
} from "../lib/privacyCash";
import { txUrl } from "../lib/explorer";

/**
 * Shield moves SOL from a wallet into the pool; send pays someone out of it;
 * unshield is the same payment aimed back at a wallet of your own. They share
 * one balance and one session, which is why they share one dialog.
 */
type Mode = "shield" | "send" | "unshield";

/**
 * `disclosure` only appears once per install, and `opening` is the wait for
 * the signature that unlocks the pool balance. Everything after that is the
 * same shape as the other money-moving dialogs.
 */
type Phase = "disclosure" | "opening" | "form" | "confirm" | "working" | "done";

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "shield", label: "Shield", hint: "Deposit SOL from this wallet into the pool" },
  { value: "send", label: "Private send", hint: "Pay any address out of the pool" },
  { value: "unshield", label: "Unshield", hint: "Move the pool balance back to your own wallet" },
];

export function PrivacyDialog({
  settings,
  wallet,
  wallets,
  balance,
  onSettingsChanged,
  onClose,
  onFinished,
}: {
  settings: Settings;
  wallet: Wallet;
  wallets: Wallet[];
  balance: number | null;
  onSettingsChanged: (s: Settings) => void;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [mode, setMode] = useState<Mode>("shield");
  const [phase, setPhase] = useState<Phase>(settings.privacy_cash_ack ? "opening" : "disclosure");
  const [session, setSession] = useState<PrivacySession | null>(null);
  const [pooled, setPooled] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [ownDestination, setOwnDestination] = useState(wallet.pubkey);
  const [quote, setQuote] = useState<PrivacyQuote | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = phase === "working" || phase === "opening";

  /** Read the pool balance. Slow the first time — it decrypts every note. */
  const refreshPooled = useCallback(async (open: PrivacySession) => {
    const { lamports } = await privateBalance(open);
    setPooled(lamports);
  }, []);

  // Opening asks the backend for one signature, which is what derives the key
  // the notes are encrypted under. Nothing can be priced before it lands.
  useEffect(() => {
    if (phase !== "opening") return;
    let cancelled = false;
    (async () => {
      try {
        const open = await openPrivacySession(wallet.pubkey, settings.rpc_url);
        if (cancelled) return;
        setSession(open);
        setPhase("form");
        await refreshPooled(open);
      } catch (e) {
        if (!cancelled) {
          setError(asAppError(e).message);
          setPhase("form");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, wallet.pubkey, settings.rpc_url, refreshPooled]);

  async function acknowledge() {
    try {
      onSettingsChanged(await api.settingsSet({ ...settings, privacy_cash_ack: true }));
      setPhase("opening");
    } catch (e) {
      setError(asAppError(e).message);
    }
  }

  const parsed = Number(amount);
  const lamports = Math.round(parsed * LAMPORTS_PER_SOL);
  const destination = mode === "send" ? recipient.trim() : ownDestination;
  const amountValid = amount.trim() !== "" && parsed > 0 && !Number.isNaN(parsed);
  const canReview =
    Boolean(session) &&
    amountValid &&
    (mode === "shield" || (destination.length > 0 && (pooled ?? 0) >= lamports));

  async function review() {
    setError(null);
    setPhase("confirm");
    try {
      setQuote(mode === "shield" ? quoteShield(lamports) : await quotePrivateSend(lamports));
    } catch (e) {
      setError(asAppError(e).message);
      setPhase("form");
    }
  }

  async function run() {
    if (!session || !quote) return;
    setPhase("working");
    setError(null);
    try {
      if (mode === "shield") {
        setSignature(await shield(session, lamports));
        setNote(`Shielded ${toSol(lamports)} SOL. It is spendable privately from the pool.`);
      } else {
        const result = await privateSend(session, lamports, destination);
        setSignature(result.signature);
        setNote(
          `${result.partial ? "Partially sent" : "Sent"} ${toSol(result.amount)} SOL to ${shortKey(
            result.recipient,
          )} for ${toSol(result.fee)} SOL in fees.`,
        );
      }
      setPhase("done");
      onFinished();
      // The pool balance moved either way, and the figure in the header is
      // the only thing telling the user what is left to spend.
      refreshPooled(session).catch(() => {});
    } catch (e) {
      setError(asAppError(e).message);
      setPhase("confirm");
    }
  }

  return (
    <Modal
      title={
        <span>
          Privacy Cash — <span className="text-brand-500">{wallet.label}</span>
        </span>
      }
      onClose={onClose}
      busy={busy}
      width="max-w-lg"
      footer={
        <>
          <span className="flex-1 font-mono text-xs text-mist-500">
            {phase === "disclosure"
              ? "third-party protocol"
              : pooled === null
                ? "reading pool balance…"
                : `pool ${toSol(pooled)} SOL`}
          </span>
          <Button onClick={onClose} disabled={busy}>
            {phase === "done" ? "Close" : "Cancel"}
          </Button>
          {phase === "disclosure" && (
            <Button variant="primary" onClick={acknowledge}>
              I understand
            </Button>
          )}
          {phase === "form" && (
            <Button variant="primary" onClick={review} disabled={!canReview}>
              Review
            </Button>
          )}
          {(phase === "confirm" || phase === "working") && (
            <Button variant="primary" onClick={run} disabled={busy || !quote}>
              {phase === "working" ? <Spinner /> : null}
              {phase === "working" ? "Proving…" : "Confirm"}
            </Button>
          )}
        </>
      }
    >
      {error && <Banner kind="error">{error}</Banner>}

      {phase === "disclosure" && <Disclosure />}

      {phase === "done" && signature && (
        <>
          <Banner kind="success">{note}</Banner>
          <Button variant="ghost" size="sm" onClick={() => openUrl(txUrl(settings, signature))}>
            View on Solana Explorer ↗
          </Button>
        </>
      )}

      {(phase === "opening" || phase === "form" || phase === "confirm" || phase === "working") && (
        <>
          <SegmentedControl
            className="mb-3"
            value={mode}
            options={MODES}
            onChange={(next) => {
              setMode(next);
              setQuote(null);
              setPhase("form");
            }}
          />

          {phase === "opening" && (
            <p className="mb-3 flex items-center gap-2 text-[11px] text-mist-500">
              <Spinner /> Deriving this wallet's pool key and reading its notes…
            </p>
          )}

          {mode === "shield" ? (
            <Field
              label="From"
              hint={
                balance === null
                  ? undefined
                  : `This wallet holds ${toSol(balance)} SOL. The network fee is paid on top.`
              }
            >
              <div
                className="border border-ink-600 bg-ink-950 px-2 py-1 font-mono text-[11px] text-mist-300"
                title={wallet.pubkey}
              >
                {shortKey(wallet.pubkey)}
              </div>
            </Field>
          ) : mode === "send" ? (
            <Field
              label="Recipient address"
              hint="Paid out of the pool by Privacy Cash's relayer, so it cannot be traced back to the wallet that deposited."
            >
              <Input
                className="font-mono text-xs"
                value={recipient}
                autoFocus
                placeholder="Recipient Solana address"
                disabled={phase !== "form"}
                onChange={(e) => setRecipient(e.target.value)}
              />
            </Field>
          ) : (
            <Field label="Back to wallet">
              <Select
                value={ownDestination}
                disabled={phase !== "form"}
                onChange={(e) => setOwnDestination(e.target.value)}
              >
                {wallets.map((w) => (
                  <option key={w.pubkey} value={w.pubkey}>
                    {w.label} — {shortKey(w.pubkey)}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label="Amount (SOL)"
            hint={mode === "shield" ? undefined : "Taken from the pool balance, not from the wallet."}
          >
            <Input
              type="number"
              step="0.000000001"
              min="0"
              value={amount}
              placeholder="0.0"
              disabled={phase !== "form"}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>

          {mode !== "shield" && pooled !== null && amountValid && lamports > pooled && (
            <Banner kind="warning">
              The pool holds {toSol(pooled)} SOL for this wallet — less than you asked to send.
            </Banner>
          )}

          {(phase === "confirm" || phase === "working") && quote && (
            <div className="border border-ink-600 bg-ink-950 p-2 font-mono text-[11px]">
              <Row
                label={mode === "shield" ? "Into the pool" : "Recipient gets"}
                value={`${toSol(quote.net)} SOL`}
                strong
              />
              <Row
                label={mode === "shield" ? "Protocol fee" : "Relayer fee"}
                value={`${toSol(quote.fee)} SOL`}
              />
              {quote.minimum !== null && quote.amount < quote.minimum && (
                <Row label="Below minimum" value={`${toSol(quote.minimum)} SOL`} />
              )}
              {mode !== "shield" && (
                <div className="mt-2 border-t border-ink-600 pt-2 break-all text-mist-300">
                  → {destination}
                </div>
              )}
            </div>
          )}

          {phase === "working" && (
            <p className="mt-2 text-[11px] leading-snug text-mist-500">
              Generating the zero-knowledge proof. This takes a while and cannot be interrupted —
              leave the window open.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Shown once, before the first use. Privacy Cash is someone else's contract
 * and someone else's relayer, running on mainnet with real funds, and none of
 * that is obvious from a dialog that otherwise looks like the send screen.
 */
function Disclosure() {
  return (
    <div className="text-[11px] leading-relaxed text-mist-300">
      <Banner kind="warning">
        Privacy Cash is a third-party protocol. LocalWallet has not audited it.
      </Banner>
      <ul className="mt-2 ml-4 list-disc space-y-1.5">
        <li>
          Deposits go to a smart contract this app does not control. If it fails, the funds in it
          are lost — this is not a transfer you can reverse or a balance this app can recover.
        </li>
        <li>
          Withdrawals are submitted by Privacy Cash's relayer, which charges a fee and sees the
          recipient address. It never holds your funds.
        </li>
        <li>
          Mainnet only, with real SOL. There is no test network to rehearse on. Start with an
          amount you are willing to lose outright.
        </li>
        <li>
          Privacy comes from the crowd in the pool and from time. Depositing and immediately
          withdrawing the same unusual amount links the two ends by itself.
        </li>
        <li>
          Your keys stay in the vault. Signing happens in the backend as it does everywhere else in
          this app.
        </li>
      </ul>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-mist-500">{label}</span>
      <span className={strong ? "text-brand-500" : "text-mist-50"}>{value}</span>
    </div>
  );
}
