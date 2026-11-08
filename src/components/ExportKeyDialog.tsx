import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Banner, Button, Input, SegmentedControl, Spinner } from "./ui";
import { api, asAppError, shortKey, type ExportedSecret, type Wallet } from "../lib/api";

type Format = "base58" | "json";

/** How long the key stays on screen, and how long a copy stays on the clipboard. */
const SHOW_SECS = 60;
const CLIPBOARD_SECS = 30;

/**
 * Show one wallet's private key.
 *
 * Two steps. First the master password (the backend checks it, then asks the
 * user to confirm in a native dialog this window cannot click). Then the key,
 * blurred until revealed, closing itself after a minute, and dropped from
 * memory the moment the dialog goes away.
 */
export function ExportKeyDialog({ wallet, onClose }: { wallet: Wallet; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<ExportedSecret | null>(null);
  const [format, setFormat] = useState<Format>("base58");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState(SHOW_SECS);
  const closing = useRef(false);

  // Count down and close; the key never outlives the countdown.
  useEffect(() => {
    if (!secret) return;
    const t = window.setInterval(() => setLeft((s) => s - 1), 1000);
    return () => window.clearInterval(t);
  }, [secret]);
  useEffect(() => {
    if (secret && left <= 0 && !closing.current) {
      closing.current = true;
      onClose();
    }
  }, [secret, left, onClose]);

  // Drop everything on the way out.
  useEffect(
    () => () => {
      setSecret(null);
      setPassword("");
    },
    [],
  );

  async function reveal(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      setSecret(await api.walletExportSecret(wallet.pubkey, password));
      setPassword("");
    } catch (err) {
      const a = asAppError(err);
      setError(a.kind === "BadPassword" ? "Incorrect password." : a.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(format === "base58" ? secret.base58 : secret.json);
      setCopied(true);
      // Overwrite the clipboard so the key does not sit there indefinitely.
      window.setTimeout(() => void navigator.clipboard.writeText(" ").catch(() => {}), CLIPBOARD_SECS * 1000);
    } catch {
      setError("Could not copy to the clipboard.");
    }
  }

  const shown = secret ? (format === "base58" ? secret.base58 : secret.json) : "";

  return (
    <Modal
      title="Export private key"
      onClose={onClose}
      busy={busy}
      width="max-w-md"
      footer={
        secret ? (
          <>
            <span className="text-[11px] text-mist-500">Closes in {Math.max(left, 0)} s</span>
            <span className="flex-1" />
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : undefined
      }
    >
      <p className="mb-3 text-center text-[13px] font-medium">{wallet.label}</p>
      <p className="mb-3 text-center font-mono text-[11px] text-mist-500">
        {shortKey(wallet.pubkey, 8, 8)}
      </p>

      {!secret ? (
        <form onSubmit={reveal}>
          <Banner kind="warning">
            Anyone who sees this key can take everything in the wallet, and nothing can undo it. Do
            not paste it into a website, a chat or an email. You will be asked to confirm in a
            separate system dialog.
          </Banner>
          {error && <Banner kind="error">{error}</Banner>}
          <label className="mb-1 block text-[11px] text-mist-300" htmlFor="export-password">
            Master password
          </label>
          <Input
            id="export-password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your master password"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !password}>
              {busy && <Spinner />}
              Continue
            </Button>
          </div>
        </form>
      ) : (
        <div>
          {error && <Banner kind="error">{error}</Banner>}
          <SegmentedControl<Format>
            className="mb-3"
            value={format}
            onChange={(f) => {
              setFormat(f);
              setCopied(false);
            }}
            options={[
              { value: "base58", label: "Base58 (Phantom, Solflare)" },
              { value: "json", label: "JSON array (Solana CLI)" },
            ]}
          />
          <div className="relative">
            <div
              className={`max-h-40 overflow-auto rounded-lg border border-white/10 bg-ink-950 p-3 font-mono text-[11px] break-all select-all ${
                revealed ? "" : "blur-md select-none"
              }`}
              aria-hidden={!revealed}
            >
              {shown}
            </div>
            {!revealed && (
              <button
                onClick={() => setRevealed(true)}
                className="absolute inset-0 grid place-items-center text-[12px] font-medium text-mist-50"
              >
                Click to reveal
              </button>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button onClick={() => void copy()} disabled={!revealed}>
              {copied ? "Copied" : "Copy"}
            </Button>
            <span className="text-[11px] text-mist-500">
              {copied
                ? `The clipboard is overwritten after ${CLIPBOARD_SECS} s.`
                : "The clipboard is overwritten 30 s after you copy."}
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}
