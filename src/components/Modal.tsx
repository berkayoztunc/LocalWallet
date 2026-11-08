import { useEffect, type ReactNode } from "react";

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Blocks dismissal while a long operation is running. */
  busy?: boolean;
  width?: string;
}

/**
 * A macOS-style sheet: traffic-light close at the left, centred title, softly
 * rounded corners over a blurred scrim. Every dialog in the app goes through
 * this, so the look changes in exactly one place.
 */
export function Modal({ title, onClose, children, footer, busy, width = "max-w-2xl" }: Props) {
  // Escape closes, unless something irreversible is mid-flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/45 p-6 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`animate-pop-in flex max-h-[86vh] w-full ${width} flex-col overflow-hidden rounded-xl border border-white/10 bg-ink-850 shadow-float`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex h-11 shrink-0 items-center border-b border-white/10 bg-ink-800 px-3">
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="group z-10 grid size-3 shrink-0 place-items-center rounded-full bg-[#ff5f57] outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40"
          >
            <span className="text-[8px] leading-none font-bold text-black/60 opacity-0 group-hover:opacity-100">
              ✕
            </span>
          </button>
          <h2 className="pointer-events-none absolute inset-x-12 truncate text-center text-[13px] font-semibold">
            {title}
          </h2>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>

        {/* Action bar. Secondary actions sit left, the committing action right. */}
        {footer && (
          <div className="flex min-h-11 shrink-0 items-center gap-2 border-t border-white/10 bg-ink-800 px-3 py-1.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
