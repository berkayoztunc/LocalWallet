import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, asAppError, type RpcHealth, type Settings } from "../lib/api";
import {
  EXPLORERS,
  addressUrl,
  clusterFromRpc,
  explorerFallsBack,
  type ExplorerId,
} from "../lib/explorer";
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Pill,
  SegmentedControl,
  Spinner,
  cx,
} from "../components/ui";
import { Logo } from "../components/Logo";

const SECTIONS = [
  { id: "network", label: "Network" },
  { id: "explorer", label: "Explorer" },
  { id: "sweeping", label: "Sweeping" },
  { id: "security", label: "Security" },
  { id: "backup", label: "Backup" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** A real address, so the preview link shows exactly what will open. */
const SAMPLE_ADDRESS = "So11111111111111111111111111111111111111112";

export function SettingsScreen({
  settings,
  onSettingsChanged,
  onBack,
}: {
  settings: Settings;
  onSettingsChanged: (s: Settings) => void;
  onBack: () => void;
}) {
  const [section, setSection] = useState<SectionId>("network");
  const [draft, setDraft] = useState<Settings>(settings);
  const [health, setHealth] = useState<RpcHealth | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changing, setChanging] = useState(false);
  // Read from the bundle rather than a hardcoded string, so an installed build
  // can always identify itself.
  const [version, setVersion] = useState("");

  useEffect(() => {
    let active = true;
    getVersion().then((v) => {
      if (active) setVersion(v);
    });
    return () => {
      active = false;
    };
  }, []);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const cluster = clusterFromRpc(draft.rpc_url);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft({ ...draft, [key]: value });
  }

  async function persist() {
    setSaving(true);
    try {
      const saved = await api.settingsSet(draft);
      setDraft(saved);
      onSettingsChanged(saved);
      setMessage({ kind: "success", text: "Settings saved." });
    } catch (e) {
      setMessage({ kind: "error", text: asAppError(e).message });
    } finally {
      setSaving(false);
    }
  }

  async function testRpc() {
    setTesting(true);
    setHealth(null);
    try {
      setHealth(await api.rpcTest(draft.rpc_url));
    } catch (e) {
      setMessage({ kind: "error", text: asAppError(e).message });
    } finally {
      setTesting(false);
    }
  }

  async function changePassword() {
    if (newPassword !== confirmPassword) {
      setMessage({ kind: "error", text: "New passwords do not match." });
      return;
    }
    setChanging(true);
    try {
      await api.vaultChangePassword(oldPassword, newPassword);
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage({ kind: "success", text: "Password changed. The vault was re-encrypted." });
    } catch (e) {
      setMessage({ kind: "error", text: asAppError(e).message });
    } finally {
      setChanging(false);
    }
  }

  async function exportVault() {
    try {
      const path = await saveDialog({
        title: "Export encrypted vault",
        defaultPath: "localwallet-vault.bin",
      });
      if (!path) return;
      await api.vaultExport(path);
      setMessage({
        kind: "success",
        text: `Encrypted vault written to ${path}. It still needs your master password to open.`,
      });
    } catch (e) {
      setMessage({ kind: "error", text: asAppError(e).message });
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-ink-600 bg-ink-850 px-2.5 py-1.5">
        <Logo size={18} />
        <span className="text-xs font-semibold tracking-tight">Settings</span>
        <span className="flex-1" />
        <Button onClick={onBack}>← Back to wallets</Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-40 shrink-0 border-r border-ink-600 py-1.5">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={cx(
                "block w-full border-l-2 px-2.5 py-1.5 text-left text-xs outline-none",
                "transition-colors duration-100 ease-[var(--ease-out)]",
                "focus-visible:ring-1 focus-visible:ring-brand-500",
                section === s.id
                  ? "border-brand-500 bg-ink-800 font-medium text-brand-500"
                  : "border-transparent text-mist-300 hover:bg-ink-850 hover:text-mist-50",
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-2xl p-3 pb-16">
            {message && <Banner kind={message.kind}>{message.text}</Banner>}

            {section === "network" && (
              <Card>
                <CardHeader title="Network" />
                <CardBody>
                  <Field
                    label="RPC endpoint"
                    hint="The public endpoint rate-limits hard. With 200 wallets, use a dedicated provider (Helius, QuickNode, Triton) or a devnet URL for testing."
                  >
                    <div className="flex gap-2">
                      <Input
                        className="font-mono text-xs"
                        value={draft.rpc_url}
                        onChange={(e) => update("rpc_url", e.target.value)}
                      />
                      <Button onClick={testRpc} disabled={testing}>
                        {testing && <Spinner />} Test
                      </Button>
                    </div>
                    {health && (
                      <div
                        className={cx(
                          "mt-2 border px-2.5 py-1.5 text-xs",
                          health.ok
                            ? "border-brand-600/30 bg-brand-600/10 text-brand-400"
                            : "border-rose-400/30 bg-rose-400/10 text-rose-400",
                        )}
                      >
                        {health.ok ? "Healthy" : "Unhealthy"}
                        {health.version && ` · solana-core ${health.version}`} ·{" "}
                        {health.latency_ms} ms
                        {health.error && ` · ${health.error}`}
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-2 text-xs text-mist-500">
                      Detected cluster: <Pill tone={cluster === "mainnet" ? "accent" : "warn"}>{cluster}</Pill>
                    </div>
                  </Field>

                  <Field label="Commitment">
                    <SegmentedControl
                      value={draft.commitment}
                      onChange={(v) => update("commitment", v)}
                      options={[
                        { value: "processed", label: "Processed", hint: "Fastest, least certain" },
                        { value: "confirmed", label: "Confirmed", hint: "Recommended" },
                        { value: "finalized", label: "Finalized", hint: "Slowest, most certain" },
                      ]}
                    />
                  </Field>

                  <Field
                    label={`Parallel wallets — ${draft.concurrency}`}
                    hint="How many wallets are processed at once. Lower this if the RPC returns 429 errors."
                  >
                    <input
                      type="range"
                      min={1}
                      max={32}
                      className="w-full accent-brand-500"
                      value={draft.concurrency}
                      onChange={(e) => update("concurrency", Number(e.target.value))}
                    />
                  </Field>

                  <Field
                    label="Priority fee (micro-lamports per compute unit)"
                    hint="Raise this if transactions are not landing during congestion. Transfers request a small compute limit, so the cost stays negligible."
                  >
                    <Input
                      type="number"
                      min={0}
                      value={draft.priority_fee_microlamports}
                      onChange={(e) => update("priority_fee_microlamports", Number(e.target.value))}
                    />
                  </Field>
                </CardBody>
              </Card>
            )}

            {section === "explorer" && (
              <Card>
                <CardHeader title="Explorer" />
                <CardBody>
                  <Field
                    label="Preferred explorer"
                    hint="Every address, token and transaction link in the app opens here."
                  >
                    <SegmentedControl
                      value={draft.explorer as ExplorerId}
                      onChange={(v) => update("explorer", v)}
                      options={EXPLORERS.map((e) => ({
                        value: e.id,
                        label: e.name,
                        hint: e.host,
                      }))}
                    />
                  </Field>

                  {explorerFallsBack(draft) && (
                    <Banner kind="warning">
                      Orb only indexes mainnet. While the RPC points at {cluster}, links fall back to
                      Solana Explorer so they resolve to real data.
                    </Banner>
                  )}

                  <div className="mb-3 border border-ink-600 bg-ink-950 p-2.5">
                    <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-mist-300">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-brand-500"
                        checked={draft.validator_directory}
                        onChange={(e) => update("validator_directory", e.target.checked)}
                      />
                      <span>
                        <span className="text-mist-50">Look up validator names</span> from the
                        public Stakewiz directory. This is the only request the app makes to
                        anything other than your RPC. It sends no address and no key — only that
                        someone running LocalWallet asked for the validator list, and your IP.
                        Turn it off and validators show as vote addresses.
                      </span>
                    </label>
                  </div>

                  <div className="border border-ink-600 bg-ink-950 p-3">
                    <div className="mb-1.5 text-[10px] tracking-wider text-mist-500 uppercase">
                      Link preview
                    </div>
                    <button
                      className="font-mono text-xs break-all text-brand-500 hover:underline"
                      onClick={() => openUrl(addressUrl(draft, SAMPLE_ADDRESS))}
                    >
                      {addressUrl(draft, SAMPLE_ADDRESS)}
                    </button>
                  </div>
                </CardBody>
              </Card>
            )}

            {section === "sweeping" && (
              <Card>
                <CardHeader title="Sweeping" />
                <CardBody>
                  <Field
                    label="Default destination address"
                    hint="Only a default — the sweep dialog still requires you to retype it before sending."
                  >
                    <Input
                      className="font-mono text-xs"
                      value={draft.destination_pubkey ?? ""}
                      placeholder="Pre-fills the sweep and send dialogs"
                      onChange={(e) => update("destination_pubkey", e.target.value.trim() || null)}
                    />
                  </Field>
                </CardBody>
              </Card>
            )}

            {section === "security" && (
              <>
                <Card className="mb-4">
                  <CardHeader title="Auto-lock" />
                  <CardBody>
                    <Field
                      label="Lock after (minutes, 0 disables)"
                      hint="The vault closes itself after this long without mouse or keyboard activity."
                    >
                      <Input
                        type="number"
                        min={0}
                        max={1440}
                        value={draft.auto_lock_minutes}
                        onChange={(e) => update("auto_lock_minutes", Number(e.target.value))}
                      />
                    </Field>
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader title="Master password" />
                  <CardBody>
                    <Field label="Current password">
                      <Input
                        type="password"
                        value={oldPassword}
                        onChange={(e) => setOldPassword(e.target.value)}
                      />
                    </Field>
                    <Field label="New password">
                      <Input
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                      />
                    </Field>
                    <Field label="Confirm new password">
                      <Input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                      />
                    </Field>
                    <Button
                      onClick={changePassword}
                      disabled={changing || !oldPassword || newPassword.length < 8}
                    >
                      {changing && <Spinner />}
                      {changing ? "Re-encrypting…" : "Change password"}
                    </Button>
                  </CardBody>
                </Card>
              </>
            )}

            {section === "backup" && (
              <Card>
                <CardHeader title="Backup" />
                <CardBody>
                  <p className="mb-3 text-[13px] leading-relaxed text-mist-300">
                    Exports <span className="font-mono text-xs">vault.bin</span> exactly as stored —
                    still encrypted, still requires your master password. There is no password
                    recovery, so keep a copy of both.
                  </p>
                  <Button onClick={exportVault}>Export encrypted vault…</Button>
                </CardBody>
              </Card>
            )}

            <p className="mt-4 text-center text-[11px] text-mist-500">
              LocalWallet{version && ` v${version}`}
            </p>
          </div>
        </div>
      </div>

      {/* Only appears when there is something to lose. */}
      {dirty && (
        <div className="animate-pop-in shrink-0 border-t border-ink-600 bg-ink-800 px-3 py-1.5">
          <div className="mx-auto flex h-7 max-w-2xl items-center gap-2">
            <span className="flex-1 text-[11px] text-mist-300">Unsaved changes</span>
            <Button onClick={() => setDraft(settings)} disabled={saving}>
              Discard
            </Button>
            <Button variant="primary" onClick={persist} disabled={saving}>
              {saving && <Spinner />}
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
