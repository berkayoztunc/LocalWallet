import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { api, asAppError, type Settings } from "./lib/api";
import { Setup } from "./screens/Setup";
import { Unlock } from "./screens/Unlock";
import { Dashboard } from "./screens/Dashboard";
import { SettingsScreen } from "./screens/SettingsScreen";
import { StakeScreen } from "./screens/StakeScreen";

type Screen = "loading" | "setup" | "unlock" | "dashboard" | "settings" | "stake";

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const idleTimer = useRef<number | null>(null);

  const enterVault = useCallback(async () => {
    try {
      setSettings(await api.settingsGet());
      setScreen("dashboard");
    } catch (e) {
      setFatal(asAppError(e).message);
    }
  }, []);

  useEffect(() => {
    api
      .vaultStatus()
      .then((status) => {
        if (status.unlocked) return enterVault();
        setScreen(status.exists ? "unlock" : "setup");
      })
      .catch((e) => setFatal(asAppError(e).message));
  }, [enterVault]);

  const lock = useCallback(async () => {
    await api.vaultLock();
    setScreen("unlock");
  }, []);

  // Auto-lock: any input resets the timer, so the vault only closes after a
  // genuine stretch of inactivity.
  useEffect(() => {
    const minutes = settings?.auto_lock_minutes ?? 0;
    if (minutes <= 0 || (screen !== "dashboard" && screen !== "settings")) return;

    const reset = () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => void lock(), minutes * 60_000);
    };
    const events = ["mousedown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, reset));
    reset();

    return () => {
      events.forEach((e) => window.removeEventListener(e, reset));
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
    };
  }, [settings?.auto_lock_minutes, screen, lock]);

  if (fatal) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <div className="animate-pop-in w-full max-w-md border border-ink-600 bg-ink-850 p-7 shadow-float">
          <h1 className="mb-3 text-xl font-semibold">Something went wrong</h1>
          <div className="border border-rose-400/30 bg-rose-400/10 px-3 py-2.5 text-[13px] text-rose-400">
            {fatal}
          </div>
        </div>
      </div>
    );
  }

  if (screen === "loading") {
    return <div className="grid min-h-full place-items-center text-mist-300">Loading…</div>;
  }

  if (screen === "setup") {
    return <Setup onDone={enterVault} />;
  }

  if (screen === "unlock") {
    return <Unlock onUnlocked={enterVault} />;
  }

  if (!settings) {
    return <div className="grid min-h-full place-items-center text-mist-300">Loading settings…</div>;
  }

  if (screen === "stake") {
    return <StakeScreen settings={settings} onBack={() => setScreen("dashboard")} />;
  }

  if (screen === "settings") {
    return (
      <SettingsScreen
        settings={settings}
        onSettingsChanged={setSettings}
        onBack={() => setScreen("dashboard")}
      />
    );
  }

  return (
    <Dashboard
      settings={settings}
      onSettingsChanged={setSettings}
      onOpenSettings={() => setScreen("settings")}
      onOpenStake={() => setScreen("stake")}
      onLock={lock}
    />
  );
}
