import { useEffect, useRef, useState } from "react";
import { api, asAppError } from "../lib/api";
import { Banner, Button, Field, Input, Spinner } from "../components/ui";
import { Logo } from "../components/Logo";

/**
 * Argon2id already makes each guess expensive. This adds a growing in-app
 * delay after repeated wrong passwords so an unattended machine cannot be
 * hammered quickly.
 */
function lockoutSeconds(attempts: number): number {
  if (attempts < 3) return 0;
  return Math.min(60, 2 ** (attempts - 2));
}

export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [waitLeft, setWaitLeft] = useState(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (waitLeft <= 0) return;
    timer.current = window.setTimeout(() => setWaitLeft((s) => s - 1), 1000);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [waitLeft]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || waitLeft > 0 || !password) return;
    setBusy(true);
    setError(null);
    try {
      await api.vaultUnlock(password);
      setPassword("");
      setAttempts(0);
      onUnlocked();
    } catch (e) {
      const err = asAppError(e);
      const next = attempts + 1;
      setAttempts(next);
      setWaitLeft(lockoutSeconds(next));
      setError(err.kind === "BadPassword" ? "Incorrect password." : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <form
        className="animate-pop-in w-full max-w-sm border border-ink-500 bg-ink-850 p-5 shadow-float"
        onSubmit={submit}
      >
        <Logo size={28} className="mb-4" />
        <h1 className="text-base font-semibold">Unlock vault</h1>
        <p className="mt-1 mb-4 text-xs text-mist-300">
          Enter your master password to decrypt your wallets.
        </p>

        {error && <Banner kind="error">{error}</Banner>}
        {waitLeft > 0 && (
          <Banner kind="warning">Too many attempts. Try again in {waitLeft}s.</Banner>
        )}

        <Field label="Master password">
          <Input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={waitLeft > 0}
          />
        </Field>

        <Button
          type="submit"
          variant="primary"
          className="w-full"
          disabled={busy || waitLeft > 0 || !password}
        >
          {busy && <Spinner />}
          {busy ? "Decrypting…" : "Unlock"}
        </Button>
      </form>
    </div>
  );
}
