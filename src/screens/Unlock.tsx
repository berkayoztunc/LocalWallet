import { useEffect, useRef, useState } from "react";
import { api, asAppError } from "../lib/api";
import { Button, Spinner, cx } from "../components/ui";
import { IconEye, IconEyeOff, IconLock } from "../components/icons";
import logoUrl from "../assets/logo-256.png";

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
  const [reveal, setReveal] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
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

  const locked = waitLeft > 0;

  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-ink-950 px-6">
      {/* Backdrop: a faint grid with the brand glow bleeding through it. Pure
          CSS, so it costs nothing and scales to any window size. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            "linear-gradient(to right, #1c2f38 1px, transparent 1px), linear-gradient(to bottom, #1c2f38 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse 90% 60% at 50% 42%, #000 25%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(ellipse 90% 60% at 50% 42%, #000 25%, transparent 78%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-[26%] left-1/2 size-[520px] -translate-x-1/2 -translate-y-1/2"
        style={{
          background:
            "radial-gradient(circle, rgba(1,238,197,0.16) 0%, rgba(1,238,197,0.05) 35%, transparent 68%)",
        }}
      />

      <div className="animate-pop-in relative w-full max-w-[380px]">
        {/* Brand block */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="relative mb-5">
            <div
              aria-hidden="true"
              className="absolute inset-0 blur-2xl"
              style={{
                background: "radial-gradient(circle, rgba(1,238,197,0.35), transparent 70%)",
              }}
            />
            <img
              src={logoUrl}
              alt=""
              width={96}
              height={96}
              draggable={false}
              className="relative size-24 object-contain select-none"
            />
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-mist-50">LocalWallet</h1>
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-mist-500">
            <IconLock size={12} />
            Vault locked
          </p>
        </div>

        {/* Password */}
        <form onSubmit={submit}>
          <div
            className={cx(
              "flex items-center border bg-ink-900/80 transition-colors duration-150 ease-[var(--ease-out)]",
              error ? "border-rose-400/60" : "border-ink-500 focus-within:border-brand-500",
            )}
          >
            <input
              type={reveal ? "text" : "password"}
              autoFocus
              value={password}
              disabled={locked}
              placeholder="Master password"
              aria-label="Master password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyUp={(e) => setCapsLock(e.getModifierState("CapsLock"))}
              onKeyDown={(e) => setCapsLock(e.getModifierState("CapsLock"))}
              className="h-11 min-w-0 flex-1 bg-transparent px-3.5 text-sm tracking-wide text-mist-50 outline-none placeholder:tracking-normal placeholder:text-mist-500 disabled:opacity-50"
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? "Hide password" : "Show password"}
              title={reveal ? "Hide password" : "Show password"}
              className="grid h-11 w-11 shrink-0 place-items-center text-mist-500 outline-none hover:text-mist-50 focus-visible:ring-1 focus-visible:ring-brand-500"
            >
              {reveal ? <IconEyeOff /> : <IconEye />}
            </button>
          </div>

          {/* One reserved line for every transient message, so the layout never
              jumps as the user types or fails an attempt. */}
          <div className="mt-2 min-h-8 text-xs">
            {locked ? (
              <p className="border-l-2 border-amber-warn/50 bg-amber-warn/10 px-2 py-1.5 text-amber-warn">
                Too many attempts — try again in {waitLeft}s
              </p>
            ) : error ? (
              <p className="border-l-2 border-rose-400/60 bg-rose-400/10 px-2 py-1.5 text-rose-400">
                {error}
              </p>
            ) : capsLock ? (
              <p className="border-l-2 border-amber-warn/50 bg-amber-warn/10 px-2 py-1.5 text-amber-warn">
                Caps Lock is on
              </p>
            ) : null}
          </div>

          <Button
            type="submit"
            variant="primary"
            className="mt-1 h-10 w-full text-sm"
            disabled={busy || locked || !password}
          >
            {busy && <Spinner />}
            {busy ? "Decrypting…" : "Unlock"}
          </Button>
        </form>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-mist-500">
          Your keys are encrypted on this machine and never leave it.
          <br />
          There is no password recovery.
        </p>
      </div>
    </div>
  );
}
