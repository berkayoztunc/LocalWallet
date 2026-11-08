import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { api, asAppError, type Settings } from "./lib/api";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { forgetPrivacySessions } from "./lib/privacySessions";
import { Setup } from "./screens/Setup";
import { Unlock } from "./screens/Unlock";
import { Dashboard } from "./screens/Dashboard";
import { SettingsScreen } from "./screens/SettingsScreen";
import { StakeScreen } from "./screens/StakeScreen";

type Screen = "loading" | "setup" | "unlock" | "dashboard" | "settings" | "stake";

/**
 * The screens shown before the vault is open, and so the only ones auto-lock
 * has nothing to do on.
 *
 * Listed as what to skip rather than what to cover: the previous version named
 * the two screens that *did* arm the timer, which silently left the stake
 * screen — added later — holding a vault open indefinitely. Any screen added
 * from here is protected unless someone deliberately adds it to this list.
 */
const PRE_UNLOCK: readonly Screen[] = ["loading", "setup", "unlock"];

function AppInner() {
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
    // An open Privacy Cash session holds a key derived from a signature, which
    // would otherwise outlive the vault it came from. Auto-lock runs through
    // here too, which is why it is not left to the Lock button.
    forgetPrivacySessions();
    setScreen("unlock");
  }, []);

  // The native macOS menu (Settings… ⌘, and Lock Vault ⌘L) reaches the UI as
  // events. Both are ignored before the vault is open.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    const subs: Promise<UnlistenFn>[] = [
      listen("menu://settings", () =>
        setScreen((s) => (PRE_UNLOCK.includes(s) ? s : "settings")),
      ),
      listen("menu://lock", () => {
        if (!PRE_UNLOCK.includes(screenRef.current)) void lock();
      }),
    ];
    return () => {
      subs.forEach((p) => void p.then((off) => off()).catch(() => {}));
    };
  }, [lock]);

  // Auto-lock: any input resets the timer, so the vault only closes after a
  // genuine stretch of inactivity.
  useEffect(() => {
    const minutes = settings?.auto_lock_minutes ?? 0;
    if (minutes <= 0 || PRE_UNLOCK.includes(screen)) return;

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
        <div className="animate-pop-in w-full max-w-md rounded-2xl border border-white/10 bg-ink-850 p-7 shadow-float">
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

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/**
 * macOS draws no title bar for this window (`titleBarStyle: Overlay`), so the
 * traffic lights float over the page. This strip gives them room, makes the top
 * of the window draggable, and carries the centred app name, the same colour as
 * the toolbar below it so the two read as one unified title bar. Other
 * platforms keep their native frame.
 */
export default function App() {
  if (!IS_MAC) return <AppInner />;
  return (
    <div className="flex h-full flex-col">
      <div
        data-tauri-drag-region
        className="flex h-7 shrink-0 items-center justify-center bg-ink-850 text-[13px] font-semibold text-mist-300 select-none"
      >
        <span data-tauri-drag-region className="pointer-events-none">
          LocalWallet
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <AppInner />
      </div>
    </div>
  );
}
