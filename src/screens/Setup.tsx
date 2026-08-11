import { useState } from "react";
import { api, asAppError } from "../lib/api";
import { Button, Spinner, cx } from "../components/ui";
import { IconEye, IconEyeOff } from "../components/icons";
import logoUrl from "../assets/logo-256.png";

const MIN_LENGTH = 8;

function strength(password: string): { label: string; tone: string; bars: number } {
  let score = 0;
  if (password.length >= 12) score++;
  if (password.length >= 20) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^\w\s]/.test(password)) score++;
  if (score <= 1) return { label: "weak", tone: "bg-rose-400", bars: 1 };
  if (score <= 3) return { label: "fair", tone: "bg-amber-warn", bars: 2 };
  return { label: "strong", tone: "bg-brand-500", bars: 3 };
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = password.length >= MIN_LENGTH && password === confirm && acknowledged && !busy;
  const s = strength(password);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api.vaultCreate(password);
      setPassword("");
      setConfirm("");
      onDone();
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(false);
    }
  }

  const fieldShell =
    "flex items-center border bg-ink-900/80 transition-colors duration-150 ease-[var(--ease-out)]";
  const fieldInput =
    "h-10 min-w-0 flex-1 bg-transparent px-3 text-sm tracking-wide text-mist-50 outline-none placeholder:tracking-normal placeholder:text-mist-500";

  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-ink-950 px-6 py-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            "linear-gradient(to right, #1c2f38 1px, transparent 1px), linear-gradient(to bottom, #1c2f38 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse 90% 60% at 50% 38%, #000 25%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(ellipse 90% 60% at 50% 38%, #000 25%, transparent 78%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-[22%] left-1/2 size-[520px] -translate-x-1/2 -translate-y-1/2"
        style={{
          background:
            "radial-gradient(circle, rgba(1,238,197,0.16) 0%, rgba(1,238,197,0.05) 35%, transparent 68%)",
        }}
      />

      <form onSubmit={submit} className="animate-pop-in relative w-full max-w-[380px]">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="relative mb-4">
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
              width={80}
              height={80}
              draggable={false}
              className="relative size-20 object-contain select-none"
            />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-mist-50">Create your vault</h1>
          <p className="mt-1.5 text-xs text-mist-500">
            This password encrypts every key you import.
          </p>
        </div>

        {error && (
          <p className="mb-3 border-l-2 border-rose-400/60 bg-rose-400/10 px-2 py-1.5 text-xs text-rose-400">
            {error}
          </p>
        )}

        <div
          className={cx(
            fieldShell,
            tooShort ? "border-rose-400/60" : "border-ink-500 focus-within:border-brand-500",
          )}
        >
          <input
            type={reveal ? "text" : "password"}
            autoFocus
            value={password}
            placeholder="Master password"
            aria-label="Master password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyUp={(e) => setCapsLock(e.getModifierState("CapsLock"))}
            onKeyDown={(e) => setCapsLock(e.getModifierState("CapsLock"))}
            className={fieldInput}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? "Hide password" : "Show password"}
            className="grid h-10 w-10 shrink-0 place-items-center text-mist-500 outline-none hover:text-mist-50 focus-visible:ring-1 focus-visible:ring-brand-500"
          >
            {reveal ? <IconEyeOff /> : <IconEye />}
          </button>
        </div>

        {/* Strength meter doubles as the length hint, so there is one line of
            feedback instead of two competing for attention. */}
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex flex-1 gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={cx("h-0.5 flex-1", password && i < s.bars ? s.tone : "bg-ink-600")}
              />
            ))}
          </div>
          <span className="w-24 text-right text-[11px] text-mist-500">
            {tooShort ? `${MIN_LENGTH - password.length} more characters` : password ? s.label : ""}
          </span>
        </div>

        <div
          className={cx(
            fieldShell,
            "mt-3",
            mismatch ? "border-rose-400/60" : "border-ink-500 focus-within:border-brand-500",
          )}
        >
          <input
            type={reveal ? "text" : "password"}
            value={confirm}
            placeholder="Confirm password"
            aria-label="Confirm password"
            onChange={(e) => setConfirm(e.target.value)}
            className={fieldInput}
          />
        </div>

        <div className="mt-2 min-h-6 text-[11px]">
          {capsLock ? (
            <p className="text-amber-warn">Caps Lock is on</p>
          ) : mismatch ? (
            <p className="text-rose-400">Passwords do not match</p>
          ) : null}
        </div>

        <label className="mb-4 flex cursor-pointer items-start gap-2 border border-ink-600 bg-ink-900/60 p-2.5 text-[11px] leading-relaxed text-mist-300">
          <input
            type="checkbox"
            className="mt-px accent-brand-500"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I understand there is <strong className="text-mist-50">no password recovery</strong>. If
            I forget it, the keys in this vault are gone permanently.
          </span>
        </label>

        <Button
          type="submit"
          variant="primary"
          className="h-10 w-full text-sm"
          disabled={!canSubmit}
        >
          {busy && <Spinner />}
          {busy ? "Creating vault…" : "Create vault"}
        </Button>
      </form>
    </div>
  );
}
