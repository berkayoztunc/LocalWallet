import type {
  ButtonHTMLAttributes,
  ComponentPropsWithRef,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  ThHTMLAttributes,
  TdHTMLAttributes,
} from "react";

/** Joins class names, dropping falsy entries. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------- Button -------------------------------- */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-control font-medium whitespace-nowrap " +
  "transition-[background-color,border-color,color,opacity,transform] duration-150 ease-[var(--ease-out)] " +
  "outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-1 " +
  "focus-visible:ring-offset-ink-900 disabled:opacity-40 disabled:pointer-events-none active:scale-[0.98]";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-brand-500 text-brand-ink hover:bg-brand-400 shadow-[0_1px_0_0_rgba(255,255,255,0.2)_inset,0_4px_16px_-4px_rgba(1,238,197,0.45)]",
  secondary: "bg-ink-800 text-mist-50 border border-ink-500 hover:bg-ink-700 hover:border-ink-400",
  ghost: "text-mist-300 hover:bg-ink-800 hover:text-mist-50",
  danger: "border border-rose-400/40 text-rose-400 hover:bg-rose-400/10 hover:border-rose-400",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-9 px-3.5 text-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button className={cx(BASE, VARIANTS[variant], SIZES[size], className)} {...props} />;
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

/* -------------------------------- Fields ------------------------------- */

const FIELD =
  "w-full rounded-control bg-ink-950 border border-ink-500 px-3 py-2 text-sm text-mist-50 " +
  "placeholder:text-mist-500 outline-none transition-colors duration-150 ease-[var(--ease-out)] " +
  "focus:border-brand-500 focus:ring-3 focus:ring-brand-500/15 disabled:opacity-50";

// React 19 passes `ref` through as an ordinary prop, so no forwardRef needed.
export function Input({ className, ...props }: ComponentPropsWithRef<"input">) {
  return <input className={cx(FIELD, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(FIELD, "resize-y font-mono text-xs", className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(FIELD, "cursor-pointer", className)} {...props} />;
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-4">
      {label && <label className="mb-1.5 block text-xs text-mist-300">{label}</label>}
      {children}
      {error ? (
        <p className="mt-1.5 text-xs text-rose-400">{error}</p>
      ) : (
        hint && <p className="mt-1.5 text-xs leading-relaxed text-mist-500">{hint}</p>
      )}
    </div>
  );
}

/**
 * Three or four fixed options read better as a segmented control than a
 * dropdown: every choice stays visible without a click.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      className={cx(
        "inline-flex w-full gap-1 rounded-control border border-ink-500 bg-ink-950 p-1",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="radio"
            aria-checked={active}
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={cx(
              "flex-1 rounded-[0.375rem] px-3 py-1.5 text-xs font-medium transition-all duration-150",
              "ease-[var(--ease-out)] outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
              active
                ? "bg-brand-500 text-brand-ink shadow-surface"
                : "text-mist-300 hover:bg-ink-800 hover:text-mist-50",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------- Card --------------------------------- */

export function Card({
  className,
  children,
  interactive,
}: {
  className?: string;
  children: ReactNode;
  interactive?: boolean;
}) {
  return (
    <div
      className={cx(
        "rounded-card border border-ink-600 bg-ink-850 shadow-surface",
        interactive && "transition-colors duration-150 ease-[var(--ease-out)] hover:border-ink-500",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-ink-600 px-4 py-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {action}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("p-4", className)}>{children}</div>;
}

/** A headline number. `loading` shows a skeleton so the layout never jumps. */
export function StatCard({
  label,
  value,
  sub,
  loading,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  loading?: boolean;
  tone?: "brand" | "cyan" | "default";
}) {
  return (
    <Card className="min-w-36 flex-1 px-3.5 py-2.5">
      <div className="text-[10px] font-medium tracking-wider text-mist-500 uppercase">{label}</div>
      {loading ? (
        <Skeleton className="mt-1.5 h-6 w-20" />
      ) : (
        <div
          className={cx(
            "tnum mt-0.5 text-lg leading-tight",
            tone === "brand"
              ? "text-brand-500"
              : tone === "cyan"
                ? "text-cyan-brand"
                : "text-mist-50",
          )}
        >
          {value}
        </div>
      )}
      {sub && <div className="mt-0.5 truncate text-[11px] text-mist-500">{sub}</div>}
    </Card>
  );
}

/* -------------------------------- Table -------------------------------- */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto rounded-card border border-ink-600", className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  className,
  numeric,
  children,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      className={cx(
        "sticky top-0 z-10 border-b border-ink-600 bg-ink-850/90 px-3 py-2.5 text-[10px]",
        "font-medium tracking-wider text-mist-500 uppercase backdrop-blur",
        numeric ? "text-right" : "text-left",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function Td({
  className,
  numeric,
  children,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td className={cx("px-3 py-2", numeric && "tnum text-right", className)} {...props}>
      {children}
    </td>
  );
}

export function Tr({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tr
      className={cx(
        "group border-b border-ink-600/70 transition-colors duration-100 last:border-0",
        "hover:bg-ink-850/60 focus-within:bg-ink-850/60",
        className,
      )}
    >
      {children}
    </tr>
  );
}

/**
 * Row actions fade in on hover, but `focus-within` keeps them reachable by
 * keyboard - a hover-only affordance is invisible to anyone tabbing through.
 * Below 1100px they stay visible, since a narrow window has no room to reveal
 * them on hover without shifting the layout.
 */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 max-[1100px]:opacity-100">
      {children}
    </div>
  );
}

/* -------------------------------- Banner ------------------------------- */

const BANNERS = {
  error: "bg-rose-400/10 border-rose-400/30 text-rose-400",
  warning: "bg-amber-warn/10 border-amber-warn/30 text-amber-warn",
  info: "bg-brand-950 border-brand-600/40 text-brand-300",
  success: "bg-brand-600/10 border-brand-600/30 text-brand-400",
} as const;

export function Banner({
  kind = "info",
  className,
  children,
}: {
  kind?: keyof typeof BANNERS;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "animate-fade-in mb-3.5 rounded-control border px-3 py-2.5 text-[13px] leading-relaxed",
        BANNERS[kind],
        className,
      )}
    >
      {children}
    </div>
  );
}

/* --------------------------------- Misc -------------------------------- */

export function Pill({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "warn" | "accent" | "purple" | "cyan" | "magenta";
}) {
  return (
    <span
      className={cx(
        "inline-block rounded-full border px-1.5 py-px text-[10px] tracking-wide uppercase",
        tone === "warn"
          ? "border-amber-warn/40 text-amber-warn"
          : tone === "accent"
            ? "border-brand-600/50 text-brand-300"
            : tone === "purple"
              ? "border-purple-brand/50 text-purple-brand"
              : tone === "cyan"
                ? "border-cyan-brand/50 text-cyan-brand"
                : tone === "magenta"
                  ? "border-magenta-brand/50 text-magenta-brand"
                  : "border-ink-500 text-mist-300",
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-skeleton rounded bg-ink-700", className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}

export function EmptyState({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-5 py-16 text-center">
      {title && <p className="mb-1 text-mist-50">{title}</p>}
      <div className="text-sm text-mist-300">{children}</div>
    </div>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="my-2.5 h-1 overflow-hidden rounded-full bg-ink-950">
      <div
        className="h-full rounded-full bg-brand-500 transition-[width] duration-300 ease-[var(--ease-out)]"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function StatusText({ status }: { status: string }) {
  const tone =
    status === "sent" || status === "closed"
      ? "text-brand-500"
      : status === "failed"
        ? "text-rose-400"
        : "text-mist-500";
  return <span className={cx("text-xs font-medium", tone)}>{status}</span>;
}

export function LogBox({ children }: { children: ReactNode }) {
  return (
    <div className="max-h-72 overflow-auto rounded-control border border-ink-600 bg-ink-950 p-2.5 font-mono text-xs">
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-ink-500 bg-ink-800 px-1 py-px font-sans text-[10px] text-mist-500">
      {children}
    </kbd>
  );
}
