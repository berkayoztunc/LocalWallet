import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal } from "./Modal";
import {
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  LogBox,
  ProgressBar,
  Spinner,
  StatusText,
  Table,
  Td,
  Th,
  Tr,
} from "./ui";
import {
  api,
  asAppError,
  onSweepProgress,
  shortKey,
  toSol,
  type Settings,
  type SweepPlan,
  type SweepProgress,
} from "../lib/api";
import { txUrl } from "../lib/explorer";

type Phase = "form" | "loading" | "preview" | "running" | "done";

export function SweepDialog({
  settings,
  defaultDestination,
  onClose,
  onFinished,
}: {
  settings: Settings;
  defaultDestination: string;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [destination, setDestination] = useState(defaultDestination);
  const [phase, setPhase] = useState<Phase>("form");
  const [plan, setPlan] = useState<SweepPlan | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [log, setLog] = useState<SweepProgress[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = onSweepProgress((p) => setLog((prev) => [...prev, p]));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function loadPreview() {
    setPhase("loading");
    setError(null);
    try {
      setPlan(await api.sweepPreview(destination.trim()));
      setPhase("preview");
    } catch (e) {
      setError(asAppError(e).message);
      setPhase("form");
    }
  }

  async function run() {
    setPhase("running");
    setError(null);
    setLog([]);
    try {
      await api.sweepRun(destination.trim());
      setPhase("done");
      onFinished();
    } catch (e) {
      setError(asAppError(e).message);
      setPhase("done");
    }
  }

  // The destination must be retyped in full. Sending 200 wallets to a typo is
  // unrecoverable, so a single click is not enough to trigger it.
  const confirmed = confirmText.trim() === destination.trim() && destination.trim().length > 0;
  const sent = log.filter((l) => l.status === "sent");
  const failed = log.filter((l) => l.status === "failed");
  const moved = sent.reduce((sum, l) => sum + l.lamports, 0);
  const last = log[log.length - 1];

  return (
    <Modal
      title="Collect all SOL"
      onClose={onClose}
      busy={phase === "running"}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose} disabled={phase === "running"}>
            {phase === "done" ? "Close" : "Cancel"}
          </Button>
          {phase === "form" && (
            <Button variant="primary" onClick={loadPreview} disabled={destination.trim().length === 0}>
              Preview
            </Button>
          )}
          {(phase === "preview" || phase === "running") && (
            <Button
              variant="primary"
              onClick={run}
              disabled={!confirmed || phase === "running" || (plan?.sweepable ?? 0) === 0}
            >
              {phase === "running" && <Spinner />}
              {phase === "running"
                ? "Sweeping…"
                : `Sweep ${plan?.sweepable ?? 0} wallet${plan?.sweepable === 1 ? "" : "s"}`}
            </Button>
          )}
        </>
      }
    >
      {error && <Banner kind="error">{error}</Banner>}

      {(phase === "form" || phase === "loading") && (
        <>
          <Field
            label="Destination address"
            hint="Every wallet is drained to zero: each sends its full balance minus the network fee. If the destination is one of your wallets, it is skipped as a source."
          >
            <Input
              className="font-mono text-xs"
              value={destination}
              autoFocus
              placeholder="Solana address that receives all the SOL"
              onChange={(e) => setDestination(e.target.value)}
            />
          </Field>
          {phase === "loading" && (
            <EmptyState>
              <Spinner className="mr-2" /> Reading balances…
            </EmptyState>
          )}
        </>
      )}

      {phase === "preview" && plan && (
        <>
          <Banner kind="warning">
            <strong>{toSol(plan.total_net)} SOL</strong> from {plan.sweepable} wallet
            {plan.sweepable === 1 ? "" : "s"} will be sent to{" "}
            <span className="font-mono break-all">{plan.destination}</span>. {plan.skipped} skipped,{" "}
            {toSol(plan.total_fees)} SOL in network fees. This cannot be undone.
          </Banner>

          <div className="max-h-64 overflow-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Wallet</Th>
                  <Th numeric>Balance</Th>
                  <Th numeric>Sends</Th>
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
                    <Td numeric>{toSol(item.lamports)}</Td>
                    <Td numeric className={item.skip_reason ? "text-mist-500" : "text-brand-500"}>
                      {item.skip_reason ? "—" : toSol(item.net)}
                    </Td>
                    <Td className="text-xs text-mist-500">{item.skip_reason ?? ""}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>

          <div className="mt-4">
            <Field
              label="Retype the destination address to confirm"
              hint="Shown in full on purpose — a truncated address hides vanity look-alikes."
            >
              <Input
                className="font-mono text-xs"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={plan.destination}
              />
            </Field>
          </div>
        </>
      )}

      {(phase === "running" || phase === "done") && (
        <>
          <Banner kind="info">
            {sent.length} sent — {toSol(moved)} SOL moved
            {failed.length > 0 && `, ${failed.length} failed`}
          </Banner>
          <ProgressBar value={last ? (last.done / last.total) * 100 : 0} />
          <LogBox>
            {log.length === 0 && <div className="py-0.5">Starting…</div>}
            {log.map((entry, i) => (
              <div key={`${entry.pubkey}-${i}`} className="flex items-baseline gap-2 py-0.5">
                <StatusText status={entry.status} />
                <span className="min-w-0 flex-1 truncate">
                  {entry.label} {shortKey(entry.pubkey)}
                  {entry.status === "sent" && ` — ${toSol(entry.lamports)} SOL`}
                  {entry.error && ` — ${entry.error}`}
                </span>
                {entry.signature && (
                  <button
                    className="text-brand-500 hover:underline"
                    onClick={() => openUrl(txUrl(settings, entry.signature!))}
                  >
                    explorer
                  </button>
                )}
              </div>
            ))}
          </LogBox>
        </>
      )}
    </Modal>
  );
}
