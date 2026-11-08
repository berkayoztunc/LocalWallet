import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, asAppError } from "../lib/api";
import { Button, Spinner, cx } from "../components/ui";
import { IconEye, IconEyeOff } from "../components/icons";
import { AppIcon, AuthBackdrop } from "../components/AuthShell";

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
  return { label: "strong", tone: "bg-ok", bars: 3 };
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"create" | "restore">("create");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreReveal, setRestoreReveal] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = password.length >= MIN_LENGTH && password === confirm && acknowledged && !busy;
  const canRestore = backupPath !== null && restorePassword.length > 0 && !busy;
  const s = strength(password);

  function switchMode(next: "create" | "restore") {
    setMode(next);
    setError(null);
  }

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

  async function chooseBackupFile() {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Vault backup", extensions: ["bin"] }],
    });
    if (typeof picked === "string") {
      setBackupPath(picked);
      setError(null);
    }
  }

  async function submitRestore(e: React.FormEvent) {
    e.preventDefault();
    if (!canRestore || !backupPath) return;
    setBusy(true);
    setError(null);
    try {
      await api.vaultRestore(backupPath, restorePassword);
      setRestorePassword("");
      setBackupPath(null);
      onDone();
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(false);
    }
  }

  const fieldShell =
    "flex items-center overflow-hidden rounded-lg border bg-white/10 transition-colors duration-150 ease-[var(--ease-out)]";
  const fieldInput =
    "h-10 min-w-0 flex-1 bg-transparent px-3 text-sm tracking-wide text-mist-50 outline-none placeholder:tracking-normal placeholder:text-mist-500";

  return (
    <AuthBackdrop width="max-w-[360px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <AppIcon size={72} />
          <div className="h-4" />
          <h1 className="text-xl font-semibold tracking-tight text-mist-50">
            {mode === "create" ? "Create your vault" : "Restore your vault"}
          </h1>
          <p className="mt-1.5 text-xs text-mist-500">
            {mode === "create"
              ? "This password encrypts every key you import."
              : "Pick an exported vault.bin and its master password."}
          </p>
        </div>

        <div className="mb-4 flex overflow-hidden rounded-lg border border-ink-600 text-xs">
          <button
            type="button"
            onClick={() => switchMode("create")}
            className={cx(
              "flex-1 py-2 font-medium transition-colors",
              mode === "create" ? "bg-ink-700 text-mist-50" : "text-mist-500 hover:text-mist-300",
            )}
          >
            Create new vault
          </button>
          <button
            type="button"
            onClick={() => switchMode("restore")}
            className={cx(
              "flex-1 py-2 font-medium transition-colors",
              mode === "restore" ? "bg-ink-700 text-mist-50" : "text-mist-500 hover:text-mist-300",
            )}
          >
            Restore from backup
          </button>
        </div>

        {error && (
          <p className="mb-3 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-400">
            {error}
          </p>
        )}

        {mode === "create" ? (
          <form onSubmit={submit}>
            <div
              className={cx(
                fieldShell,
                tooShort ? "border-rose-400/60" : "border-transparent focus-within:border-brand-500",
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
                {tooShort
                  ? `${MIN_LENGTH - password.length} more characters`
                  : password
                    ? s.label
                    : ""}
              </span>
            </div>

            <div
              className={cx(
                fieldShell,
                "mt-3",
                mismatch ? "border-rose-400/60" : "border-transparent focus-within:border-brand-500",
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

            <label className="mb-4 flex cursor-pointer items-start gap-2 rounded-lg border border-ink-600 bg-ink-900/60 p-2.5 text-[11px] leading-relaxed text-mist-300">
              <input
                type="checkbox"
                className="mt-px accent-brand-500"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                I understand there is <strong className="text-mist-50">no password recovery</strong>.
                If I forget it, the keys in this vault are gone permanently.
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
        ) : (
          <form onSubmit={submitRestore}>
            <button
              type="button"
              onClick={chooseBackupFile}
              className={cx(
                fieldShell,
                "w-full justify-between px-3 text-sm",
                "border-transparent hover:border-brand-500",
              )}
            >
              <span className={cx("truncate", backupPath ? "text-mist-50" : "text-mist-500")}>
                {backupPath ? backupPath.split(/[/\\]/).pop() : "Choose backup file…"}
              </span>
            </button>

            <div className={cx(fieldShell, "mt-3", "border-transparent focus-within:border-brand-500")}>
              <input
                type={restoreReveal ? "text" : "password"}
                value={restorePassword}
                placeholder="Master password"
                aria-label="Master password"
                onChange={(e) => setRestorePassword(e.target.value)}
                className={fieldInput}
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setRestoreReveal((v) => !v)}
                aria-label={restoreReveal ? "Hide password" : "Show password"}
                className="grid h-10 w-10 shrink-0 place-items-center text-mist-500 outline-none hover:text-mist-50 focus-visible:ring-1 focus-visible:ring-brand-500"
              >
                {restoreReveal ? <IconEyeOff /> : <IconEye />}
              </button>
            </div>

            <Button
              type="submit"
              variant="primary"
              className="mt-4 h-10 w-full text-sm"
              disabled={!canRestore}
            >
              {busy && <Spinner />}
              {busy ? "Restoring vault…" : "Restore vault"}
            </Button>
          </form>
        )}
    </AuthBackdrop>
  );
}
