import { useEffect, type ReactNode } from "react";
import { Button } from "./ui";

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
      className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`animate-pop-in flex max-h-[85vh] w-full ${width} flex-col rounded-card border border-ink-500 bg-ink-850 shadow-float`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-ink-600 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-5">{children}</div>

        {/* Secondary actions sit left, the committing action always far right. */}
        {footer && (
          <div className="flex items-center gap-2.5 border-t border-ink-600 bg-ink-850 px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
