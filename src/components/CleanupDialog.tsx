import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import {
  Banner,
  Button,
  EmptyState,
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
  onCleanupProgress,
  shortKey,
  toSol,
  type CleanupPreview,
  type CleanupProgress,
} from "../lib/api";

type Phase = "loading" | "preview" | "running" | "done";

export function CleanupDialog({
  onClose,
  onFinished,
  /** Restricts the run to these wallets. Undefined means every wallet. */
  pubkeys,
  scopeLabel,
}: {
  onClose: () => void;
  onFinished: () => void;
  pubkeys?: string[];
  scopeLabel?: string;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [log, setLog] = useState<CleanupProgress[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .cleanupPreview(pubkeys)
      .then((p) => {
        if (!active) return;
        setPreview(p);
        setPhase("preview");
      })
      .catch((e) => {
        if (!active) return;
        setError(asAppError(e).message);
        setPhase("preview");
      });
    return () => {
      active = false;
    };
  }, [pubkeys]);

  useEffect(() => {
    const unlisten = onCleanupProgress((p) => setLog((prev) => [...prev, p]));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function run() {
    setPhase("running");
    setError(null);
    setLog([]);
    try {
      await api.cleanupRun(pubkeys);
      setPhase("done");
      onFinished();
    } catch (e) {
      setError(asAppError(e).message);
      setPhase("done");
    }
  }

  const withAccounts = preview?.items.filter((i) => i.accounts.length > 0) ?? [];
  const closed = log.reduce((sum, l) => sum + l.accounts_closed, 0);
  const reclaimed = log.reduce((sum, l) => sum + l.reclaimed_lamports, 0);
  const last = log[log.length - 1];

  return (
    <Modal
      title={
        scopeLabel ? (
          <span>
            Close token accounts — <span className="text-brand-500">{scopeLabel}</span>
          </span>
        ) : (
          "Close unused token accounts"
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
          {phase !== "done" && (
            <Button
              variant="primary"
              onClick={run}
              disabled={phase !== "preview" || withAccounts.length === 0}
            >
              {phase === "running" && <Spinner />}
              {phase === "running"
                ? "Closing…"
                : `Close ${preview?.total_accounts ?? 0} account${preview?.total_accounts === 1 ? "" : "s"}`}
            </Button>
          )}
        </>
      }
    >
      {error && <Banner kind="error">{error}</Banner>}

      {phase === "loading" && (
        <EmptyState>
          <Spinner className="mr-2" /> Scanning token accounts…
        </EmptyState>
      )}

      {phase === "preview" && preview && (
        <>
          {preview.total_accounts === 0 ? (
            <EmptyState>No empty token accounts found. Nothing to reclaim.</EmptyState>
          ) : (
            <>
              <Banner kind="info">
                {preview.total_accounts} empty token account
                {preview.total_accounts === 1 ? "" : "s"} across {withAccounts.length} wallet
                {withAccounts.length === 1 ? "" : "s"} — about{" "}
                <strong>{toSol(preview.total_reclaimable_lamports)} SOL</strong> of rent returns to
                the wallets that own them. Sweep afterwards to consolidate it.
              </Banner>
              <Table>
                <thead>
                  <tr>
                    <Th>Wallet</Th>
                    <Th numeric>Accounts</Th>
                    <Th numeric>Rent (SOL)</Th>
                  </tr>
                </thead>
                <tbody>
                  {withAccounts.map((item) => (
                    <Tr key={item.pubkey}>
                      <Td>
                        {item.label}{" "}
                        <span className="font-mono text-xs text-mist-500">
                          {shortKey(item.pubkey)}
                        </span>
                      </Td>
                      <Td numeric>{item.accounts.length}</Td>
                      <Td numeric className="text-brand-500">
                        {toSol(item.reclaimable_lamports)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
          {preview.items.some((i) => i.error) && (
            <Banner kind="warning" className="mt-3.5">
              {preview.items.filter((i) => i.error).length} wallet(s) could not be scanned and will
              be skipped.
            </Banner>
          )}
        </>
      )}

      {(phase === "running" || phase === "done") && (
        <>
          <Banner kind="info">
            Closed {closed} account{closed === 1 ? "" : "s"} — {toSol(reclaimed)} SOL reclaimed.
          </Banner>
          <ProgressBar value={last ? (last.done / last.total) * 100 : 0} />
          <LogBox>
            {log.length === 0 && <div className="py-0.5">Starting…</div>}
            {log.map((entry, i) => (
              <div key={`${entry.pubkey}-${i}`} className="flex items-baseline gap-2 py-0.5">
                <StatusText status={entry.status} />
                <span className="min-w-0 flex-1 truncate">
                  {entry.label} {shortKey(entry.pubkey)}
                  {entry.accounts_closed > 0 && ` — ${entry.accounts_closed} closed`}
                  {entry.error && ` — ${entry.error}`}
                </span>
              </div>
            ))}
          </LogBox>
        </>
      )}
    </Modal>
  );
}
