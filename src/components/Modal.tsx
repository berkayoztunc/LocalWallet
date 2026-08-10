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
      className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/70 p-6"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`animate-pop-in flex max-h-[86vh] w-full ${width} flex-col border border-ink-500 bg-ink-850 shadow-float`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar, not a heading block: fixed height, hairline rule, and a
            close affordance parked at the right like a real window. */}
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-ink-600 bg-ink-800 pr-1 pl-3">
          <h2 className="truncate text-xs font-semibold tracking-wide">{title}</h2>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="grid size-6 shrink-0 place-items-center text-mist-500 outline-none hover:bg-ink-700 hover:text-mist-50 focus-visible:ring-1 focus-visible:ring-brand-500 disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>

        {/* Action bar. Secondary actions sit left, the committing action right. */}
        {footer && (
          <div className="flex h-10 shrink-0 items-center gap-2 border-t border-ink-600 bg-ink-800 px-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
