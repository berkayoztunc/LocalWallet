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
  "inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap " +
  "transition-[background-color,border-color,color,opacity] duration-100 ease-[var(--ease-out)] " +
  "outline-none focus-visible:ring-1 focus-visible:ring-brand-500 focus-visible:ring-offset-1 " +
  "focus-visible:ring-offset-ink-900 disabled:opacity-40 disabled:pointer-events-none";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-500 text-brand-ink hover:bg-brand-400",
  secondary: "bg-ink-800 text-mist-50 border border-ink-500 hover:bg-ink-700 hover:border-ink-400",
  ghost: "text-mist-300 hover:bg-ink-800 hover:text-mist-50",
  danger: "border border-rose-400/40 text-rose-400 hover:bg-rose-400/10 hover:border-rose-400",
};

const SIZES: Record<Size, string> = {
  sm: "h-6 px-2 text-[11px]",
  md: "h-7 px-2.5 text-xs",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button className={cx(BASE, VARIANTS[variant], SIZES[size], className)} {...props} />;
}

/**
 * A square icon-only control for dense clusters like table row actions.
 *
 * `label` is required and becomes both the tooltip and the accessible name —
 * an icon with no text is meaningless to a screen reader, and a row of
 * unlabelled glyphs is a guessing game for everyone else too.
 */
export function IconButton({
  label,
  tone,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  tone?: "brand" | "cyan" | "danger";
}) {
  return (
    <button
      title={label}
      aria-label={label}
      className={cx(
        "grid size-6 shrink-0 place-items-center text-mist-300 outline-none",
        "transition-colors duration-100 ease-[var(--ease-out)]",
        "hover:bg-ink-700 focus-visible:ring-1 focus-visible:ring-brand-500",
        // Not pointer-events-none: a disabled icon button carries the reason
        // it is disabled in its tooltip, and killing pointer events would hide
        // exactly the explanation the user is hovering to find.
        "disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent",
        tone === "brand"
          ? "text-brand-500 hover:text-brand-400"
          : tone === "cyan"
            ? "text-cyan-brand"
            : tone === "danger"
              ? "hover:text-rose-400"
              : "hover:text-mist-50",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * Joins buttons into one segmented control sharing single-pixel borders — the
 * standard desktop toolbar idiom, and the reason the toolbar reads as an
 * application rather than a row of web buttons.
 */
export function ButtonGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "inline-flex items-center [&>button]:border-l-0 [&>button:first-child]:border-l",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex flex-wrap items-center gap-1.5", className)}>{children}</div>;
}

/* -------------------------------- Fields ------------------------------- */

const FIELD =
  "w-full bg-ink-950 border border-ink-500 px-2 py-1 text-xs text-mist-50 " +
  "placeholder:text-mist-500 outline-none transition-colors duration-100 ease-[var(--ease-out)] " +
  "focus:border-brand-500 disabled:opacity-50";

// React 19 passes `ref` through as an ordinary prop, so no forwardRef needed.
export function Input({ className, ...props }: ComponentPropsWithRef<"input">) {
  return <input className={cx(FIELD, "h-7", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(FIELD, "resize-y font-mono", className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(FIELD, "h-7 cursor-pointer", className)} {...props} />;
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
    <div className="mb-3">
      {label && (
        <label className="mb-1 block text-[11px] tracking-wide text-mist-300">{label}</label>
      )}
      {children}
      {error ? (
        <p className="mt-1 text-[11px] text-rose-400">{error}</p>
      ) : (
        hint && <p className="mt-1 text-[11px] leading-snug text-mist-500">{hint}</p>
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
    <div role="radiogroup" className={cx("inline-flex w-full border border-ink-500", className)}>
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
              "flex-1 border-l border-ink-500 px-2 py-1 text-[11px] font-medium first:border-l-0",
              "transition-colors duration-100 ease-[var(--ease-out)] outline-none",
              "focus-visible:ring-1 focus-visible:ring-brand-500",
              active
                ? "bg-brand-500 text-brand-ink"
                : "bg-ink-950 text-mist-300 hover:bg-ink-800 hover:text-mist-50",
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
        "border border-ink-600 bg-ink-850",
        interactive && "transition-colors duration-100 ease-[var(--ease-out)] hover:border-ink-500",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-ink-600 bg-ink-800 px-3 py-1.5">
      <h3 className="text-xs font-semibold tracking-wide">{title}</h3>
      {action}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("p-3", className)}>{children}</div>;
}

/* ------------------------------ Status bar ----------------------------- */

/**
 * The always-visible footer. Replaces a band of stat cards: the same numbers,
 * permanently on screen, at a fraction of the vertical cost.
 */
export function StatusBar({ children }: { children: ReactNode }) {
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-ink-600 bg-ink-850 px-3 text-[11px] text-mist-500">
      {children}
    </footer>
  );
}

export function StatusItem({
  label,
  value,
  tone,
}: {
  label?: string;
  value: ReactNode;
  tone?: "brand" | "cyan" | "warn";
}) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {label && <span className="text-mist-500">{label}</span>}
      <span
        className={cx(
          "tnum",
          tone === "brand"
            ? "text-brand-500"
            : tone === "cyan"
              ? "text-cyan-brand"
              : tone === "warn"
                ? "text-amber-warn"
                : "text-mist-300",
        )}
      >
        {value}
      </span>
    </span>
  );
}

export function StatusDivider() {
  return <span className="h-3 w-px shrink-0 bg-ink-600" />;
}

/* -------------------------------- Table -------------------------------- */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto border border-ink-600", className)}>
      <table className="w-full border-collapse text-xs">{children}</table>
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
        "sticky top-0 z-10 border-b border-ink-600 bg-ink-800 px-2 py-1 text-[10px] font-medium",
        "tracking-wider text-mist-500 uppercase select-none",
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
    <td className={cx("h-7 px-2 py-0", numeric && "tnum text-right", className)} {...props}>
      {children}
    </td>
  );
}

export function Tr({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tr
      className={cx(
        "group border-b border-ink-600/60 transition-colors duration-75 last:border-0",
        "hover:bg-ink-800/70 focus-within:bg-ink-800/70",
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
    <div className="flex justify-end gap-px opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100 max-[1100px]:opacity-100">
      {children}
    </div>
  );
}

/* -------------------------------- Banner ------------------------------- */

const BANNERS = {
  error: "bg-rose-400/10 border-rose-400/40 text-rose-400",
  warning: "bg-amber-warn/10 border-amber-warn/40 text-amber-warn",
  info: "bg-brand-950 border-brand-600/40 text-brand-300",
  success: "bg-brand-600/10 border-brand-600/40 text-brand-400",
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
        "animate-fade-in mb-2.5 border-l-2 px-2.5 py-1.5 text-xs leading-snug",
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
        "inline-block border px-1 py-px text-[10px] leading-none tracking-wide uppercase",
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
  return <div className={cx("animate-skeleton bg-ink-700", className)} />;
}

// The one intentionally round thing in the app: a square spinner reads as
// broken rather than as a design choice.
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}

export function EmptyState({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-4 py-12 text-center">
      {title && <p className="mb-1 text-mist-50">{title}</p>}
      <div className="text-xs text-mist-300">{children}</div>
    </div>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="my-2 h-1 overflow-hidden bg-ink-950">
      <div
        className="h-full bg-brand-500 transition-[width] duration-300 ease-[var(--ease-out)]"
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
  return <span className={cx("text-[11px] font-medium", tone)}>{status}</span>;
}

export function LogBox({ children }: { children: ReactNode }) {
  return (
    <div className="max-h-64 overflow-auto border border-ink-600 bg-ink-950 p-2 font-mono text-[11px]">
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="border border-ink-500 bg-ink-800 px-1 py-px font-sans text-[10px] text-mist-500">
      {children}
    </kbd>
  );
}
