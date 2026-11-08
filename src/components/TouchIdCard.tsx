import { useEffect, useState } from "react";
import { api, asAppError, type BiometricStatus } from "../lib/api";
import { Banner, Button, Card, CardBody, CardHeader, Input, Spinner } from "./ui";

/**
 * Settings card for Touch ID unlock. The key, not the password, goes to the
 * login keychain, so changing the password turns this off.
 */
export function TouchIdCard() {
  const [status, setStatus] = useState<BiometricStatus | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .biometricStatus()
      .then(setStatus)
      .catch(() => setStatus({ available: false, enabled: false }));
  }, []);

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.biometricEnable(password));
      setPassword("");
    } catch (err) {
      const a = asAppError(err);
      setError(a.kind === "BadPassword" ? "Incorrect password." : a.message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.biometricDisable());
    } catch (err) {
      setError(asAppError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader title="Touch ID" />
      <CardBody>
        {error && <Banner kind="error">{error}</Banner>}
        {!status ? (
          <Spinner />
        ) : !status.available ? (
          <p className="text-[11px] leading-relaxed text-mist-500">
            Touch ID is not available here. It needs a Mac with Touch ID, a registered fingerprint
            and the macOS build of this app.
          </p>
        ) : (
          <>
            <p className="mb-3 text-[11px] leading-relaxed text-mist-300">
              Unlock the vault with your fingerprint instead of typing the master password. The
              vault key is kept in your login keychain and handed back only after a Touch ID check
              in this app. That check is enforced by the app, not by the Secure Enclave, so treat
              it as a convenience: your master password stays the real secret, and changing it turns
              Touch ID off.
            </p>
            {status.enabled ? (
              <div className="flex items-center gap-3">
                <span className="text-xs text-ok">Touch ID unlock is on.</span>
                <Button onClick={() => void disable()} disabled={busy}>
                  Turn off
                </Button>
              </div>
            ) : (
              <form onSubmit={enable} className="flex items-center gap-2">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Master password to confirm"
                  aria-label="Master password"
                  className="max-w-64"
                />
                <Button type="submit" variant="primary" disabled={busy || !password}>
                  {busy && <Spinner />}
                  Turn on Touch ID
                </Button>
              </form>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
