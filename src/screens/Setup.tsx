import { useState } from "react";
import { api, asAppError } from "../lib/api";
import { Banner, Button, Field, Input, Spinner } from "../components/ui";
import { Logo } from "../components/Logo";

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
  return { label: "strong", tone: "bg-brand-600", bars: 3 };
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
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

  return (
    <div className="grid min-h-full place-items-center p-6">
      <form
        className="animate-pop-in w-full max-w-md rounded-card border border-ink-600 bg-ink-850 p-7 shadow-float"
        onSubmit={submit}
      >
        <Logo size={40} className="mb-5" />
        <h1 className="text-xl font-semibold">Set a master password</h1>
        <p className="mt-1 mb-6 text-[13px] text-mist-300">
          Your private keys are encrypted with this password and stored only on this computer.
        </p>

        {error && <Banner kind="error">{error}</Banner>}

        <Field
          label="Master password"
          error={tooShort ? `At least ${MIN_LENGTH} characters required` : undefined}
        >
          <Input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {password.length > 0 && !tooShort && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex flex-1 gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className={`h-1 flex-1 rounded-full ${i < s.bars ? s.tone : "bg-ink-600"}`}
                  />
                ))}
              </div>
              <span className="text-xs text-mist-500">{s.label}</span>
            </div>
          )}
        </Field>

        <Field
          label="Confirm password"
          error={mismatch ? "Passwords do not match" : undefined}
        >
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>

        <label className="mb-5 flex cursor-pointer items-start gap-2.5 text-[13px] text-mist-300">
          <input
            type="checkbox"
            className="mt-1 accent-brand-500"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I understand there is <strong className="text-mist-50">no password recovery</strong>. If
            I forget this password, the keys in this vault are gone permanently.
          </span>
        </label>

        <Button type="submit" variant="primary" className="w-full" disabled={!canSubmit}>
          {busy && <Spinner />}
          {busy ? "Creating vault…" : "Create vault"}
        </Button>
      </form>
    </div>
  );
}
