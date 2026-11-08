import { useEffect, useRef, useState } from "react";
import { api, asAppError } from "../lib/api";
import { Spinner, cx } from "../components/ui";
import { AppIcon, AuthBackdrop } from "../components/AuthShell";
import { IconEye, IconEyeOff, IconFingerprint, IconLock } from "../components/icons";

/**
 * Argon2id already makes each guess expensive. This adds a growing in-app
 * delay after repeated wrong passwords so an unattended machine cannot be
 * hammered quickly.
 */
function lockoutSeconds(attempts: number): number {
  if (attempts < 3) return 0;
  return Math.min(60, 2 ** (attempts - 2));
}

/** StrictMode mounts effects twice in dev; this keeps that to one Touch ID sheet. */
let lastAutoPrompt = 0;

export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [waitLeft, setWaitLeft] = useState(0);
  const timer = useRef<number | null>(null);
  const [touchId, setTouchId] = useState(false);

  useEffect(() => {
    if (waitLeft <= 0) return;
    timer.current = window.setTimeout(() => setWaitLeft((s) => s - 1), 1000);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [waitLeft]);

  async function unlockWithTouchId() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.vaultUnlockBiometric();
      setPassword("");
      onUnlocked();
    } catch (e) {
      const msg = asAppError(e).message;
      // Dismissing the sheet is a choice, not an error.
      if (!/cancel/i.test(msg)) setError(msg);
      // A stale key is deleted by the backend; stop offering it.
      api.biometricStatus().then((s) => setTouchId(s.available && s.enabled)).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  // Offer Touch ID when it is set up, and ask for it straight away like the
  // macOS login window does. The password field stays available either way.
  useEffect(() => {
    let active = true;
    api
      .biometricStatus()
      .then((s) => {
        if (!active || !s.available || !s.enabled) return;
        setTouchId(true);
        if (Date.now() - lastAutoPrompt > 3000) {
          lastAutoPrompt = Date.now();
          void unlockWithTouchId();
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <AuthBackdrop>
      <div className="mb-6 flex flex-col items-center text-center">
        <AppIcon size={88} />
        <h1 className="mt-4 text-[17px] font-semibold text-mist-50">LocalWallet</h1>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-mist-500">
          <IconLock size={11} />
          Vault locked
        </p>
      </div>

      {/* Like the macOS login field: a pill with the submit arrow inside it. */}
      <form onSubmit={submit}>
        <div
          className={cx(
            "flex h-9 items-center rounded-full border bg-white/10 pr-1 pl-4 backdrop-blur-md",
            "transition-[border-color,box-shadow] duration-150 ease-[var(--ease-out)]",
            error
              ? "border-rose-400/60"
              : "border-white/10 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/30",
          )}
        >
          <input
            type={reveal ? "text" : "password"}
            autoFocus
            value={password}
            disabled={locked}
            placeholder="Enter Password"
            aria-label="Master password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyUp={(e) => setCapsLock(e.getModifierState("CapsLock"))}
            onKeyDown={(e) => setCapsLock(e.getModifierState("CapsLock"))}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-mist-50 outline-none placeholder:text-mist-500 disabled:opacity-50"
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? "Hide password" : "Show password"}
            title={reveal ? "Hide password" : "Show password"}
            className="grid size-7 shrink-0 place-items-center rounded-full text-mist-500 outline-none hover:text-mist-50"
          >
            {reveal ? <IconEyeOff /> : <IconEye />}
          </button>
          <button
            type="submit"
            disabled={busy || locked || !password}
            aria-label="Unlock"
            title="Unlock"
            className={cx(
              "grid size-7 shrink-0 place-items-center rounded-full text-white outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-default",
              password && !busy && !locked ? "bg-brand-500 hover:bg-brand-400" : "bg-white/15 opacity-70",
            )}
          >
            {busy ? (
              <Spinner />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14" />
                <path d="m13 6 6 6-6 6" />
              </svg>
            )}
          </button>
        </div>

        {/* One reserved line for every transient message, so the layout never
            jumps as the user types or fails an attempt. */}
        <div className="mt-3 min-h-9 text-center text-xs">
          {locked ? (
            <p className="rounded-lg border border-amber-warn/30 bg-amber-warn/10 px-3 py-2 text-amber-warn">
              Too many attempts — try again in {waitLeft}s
            </p>
          ) : error ? (
            <p className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-rose-400">
              {error}
            </p>
          ) : capsLock ? (
            <p className="rounded-lg border border-amber-warn/30 bg-amber-warn/10 px-3 py-2 text-amber-warn">
              Caps Lock is on
            </p>
          ) : busy ? (
            <p className="text-mist-500">Decrypting…</p>
          ) : null}
        </div>
      </form>

      {touchId && (
        <button
          type="button"
          onClick={() => void unlockWithTouchId()}
          disabled={busy || locked}
          className="mx-auto mt-1 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-brand-300 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-500/60 disabled:opacity-40"
        >
          <IconFingerprint size={16} />
          Unlock with Touch ID
        </button>
      )}

      <p className="mt-6 text-center text-[11px] leading-relaxed text-mist-500">
        Your keys are encrypted on this machine and never leave it.
        <br />
        There is no password recovery.
      </p>
    </AuthBackdrop>
  );
}
