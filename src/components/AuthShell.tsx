import type { ReactNode } from "react";
import logoUrl from "../assets/logo-256.png";

/**
 * The backdrop and app icon shared by the lock and setup screens: a soft
 * blurred wallpaper and a squircle app icon, like the macOS login window.
 */
export function AuthBackdrop({
  children,
  width = "max-w-[320px]",
}: {
  children: ReactNode;
  width?: string;
}) {
  return (
    <div className="relative grid h-full place-items-center overflow-auto bg-[#141416] px-6 py-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 55% at 22% 18%, rgba(10,132,255,0.22), transparent 70%)," +
            "radial-gradient(ellipse 60% 50% at 80% 85%, rgba(191,90,242,0.16), transparent 70%)," +
            "linear-gradient(180deg, #2a2a2e 0%, #141416 100%)",
        }}
      />
      <div className={`animate-pop-in relative w-full ${width}`}>{children}</div>
    </div>
  );
}

export function AppIcon({ size = 88 }: { size?: number }) {
  return (
    <div
      className="grid shrink-0 place-items-center rounded-[22.5%] border border-white/10 bg-gradient-to-b from-[#3a3a3e] to-[#1f1f22] shadow-[0_10px_30px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.08)]"
      style={{ width: size, height: size }}
    >
      <img
        src={logoUrl}
        alt=""
        width={size * 0.7}
        height={size * 0.7}
        draggable={false}
        className="object-contain select-none"
      />
    </div>
  );
}
