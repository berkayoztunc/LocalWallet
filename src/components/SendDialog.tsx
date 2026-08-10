import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal } from "./Modal";
import { Banner, Button, Field, Input, Spinner } from "./ui";
import {
  LAMPORTS_PER_SOL,
  api,
  asAppError,
  shortKey,
  toSol,
  type SendQuote,
  type Settings,
  type Wallet,
} from "../lib/api";
import { txUrl } from "../lib/explorer";

type Phase = "form" | "confirm" | "sending" | "done";

export function SendDialog({
  settings,
  wallet,
  balance,
  defaultDestination,
  onClose,
  onSent,
}: {
  settings: Settings;
  wallet: Wallet;
  balance: number | null;
  defaultDestination: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [destination, setDestination] = useState(defaultDestination);
  const [amount, setAmount] = useState("");
  const [sendMax, setSendMax] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [quote, setQuote] = useState<SendQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  // Sending the maximum is priced by the backend (balance minus the exact
  // fee), so the amount field is derived rather than typed.
  useEffect(() => {
    if (sendMax) setAmount("");
  }, [sendMax]);

  const parsedAmount = Number(amount);
  const amountValid = sendMax || (amount.trim() !== "" && parsedAmount > 0 && !Number.isNaN(parsedAmount));
  const canQuote = destination.trim().length > 0 && amountValid;

  async function getQuote() {
    setError(null);
    setPhase("confirm");
    try {
      const lamports = sendMax ? null : Math.round(parsedAmount * LAMPORTS_PER_SOL);
      setQuote(await api.sendQuote(wallet.pubkey, destination.trim(), lamports));
    } catch (e) {
      setError(asAppError(e).message);
      setPhase("form");
    }
  }

  async function send() {
    if (!quote) return;
    setPhase("sending");
    setError(null);
    try {
      const lamports = sendMax ? null : Math.round(parsedAmount * LAMPORTS_PER_SOL);
      const result = await api.sendSol(wallet.pubkey, destination.trim(), lamports);
      setSignature(result.signature);
      setPhase("done");
      onSent();
    } catch (e) {
      setError(asAppError(e).message);
      setPhase("confirm");
    }
  }

  return (
    <Modal
      title={
        <span>
          Send SOL from <span className="text-brand-500">{wallet.label}</span>
        </span>
      }
      onClose={onClose}
      busy={phase === "sending"}
      width="max-w-lg"
      footer={
        <>
          <span className="flex-1 font-mono text-xs text-mist-500">
            {balance !== null && `balance ${toSol(balance)} SOL`}
          </span>
          <Button onClick={onClose} disabled={phase === "sending"}>
            {phase === "done" ? "Close" : "Cancel"}
          </Button>
          {phase === "form" && (
            <Button variant="primary" onClick={getQuote} disabled={!canQuote}>
              Review
            </Button>
          )}
          {(phase === "confirm" || phase === "sending") && (
            <Button variant="primary" onClick={send} disabled={phase === "sending" || !quote}>
              {phase === "sending" ? <Spinner /> : null}
              {phase === "sending" ? "Sending…" : "Confirm and send"}
            </Button>
          )}
        </>
      }
    >
      {error && <Banner kind="error">{error}</Banner>}

      {phase === "done" && signature && (
        <>
          <Banner kind="success">
            Sent {toSol(quote?.amount ?? 0)} SOL to {shortKey(destination.trim())}.
          </Banner>
          <Button variant="ghost" size="sm" onClick={() => openUrl(txUrl(settings, signature))}>
            View on Solana Explorer ↗
          </Button>
        </>
      )}

      {(phase === "form" || phase === "confirm" || phase === "sending") && (
        <>
          <Field label="From">
            <div
              className="border border-ink-600 bg-ink-950 px-2 py-1 font-mono text-[11px] text-mist-300"
              title={wallet.pubkey}
            >
              {shortKey(wallet.pubkey)}
            </div>
          </Field>

          <Field label="Destination address">
            <Input
              className="font-mono text-xs"
              value={destination}
              autoFocus
              placeholder="Recipient Solana address"
              disabled={phase !== "form"}
              onChange={(e) => setDestination(e.target.value)}
            />
          </Field>

          <Field
            label="Amount (SOL)"
            hint="The network fee is paid on top of this amount, by the sending wallet."
          >
            <div className="flex gap-2">
              <Input
                type="number"
                step="0.000000001"
                min="0"
                value={sendMax ? toSol(quote?.amount ?? null) : amount}
                placeholder="0.0"
                disabled={sendMax || phase !== "form"}
                onChange={(e) => setAmount(e.target.value)}
              />
              <Button
                size="md"
                variant={sendMax ? "primary" : "secondary"}
                disabled={phase !== "form"}
                onClick={() => setSendMax((v) => !v)}
              >
                Max
              </Button>
            </div>
          </Field>

          {sendMax && (
            <Banner kind="warning">
              Max drains this wallet to zero. It will no longer be rent-exempt and the account may
              be purged — the key stays in your vault either way.
            </Banner>
          )}

          {(phase === "confirm" || phase === "sending") && quote && (
            <div className="border border-ink-600 bg-ink-950 p-2 font-mono text-[11px]">
              <Row label="Recipient gets" value={`${toSol(quote.amount)} SOL`} strong />
              <Row label="Network fee" value={`${toSol(quote.fee)} SOL`} />
              <Row label="Left in wallet" value={`${toSol(quote.remaining)} SOL`} />
              <div className="mt-2 border-t border-ink-600 pt-2 break-all text-mist-300">
                → {quote.destination}
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
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
