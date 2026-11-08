import type { ReactNode } from "react";
import { Modal } from "./Modal";
import { cx } from "./ui";

export interface ToolItem {
  id: string;
  group: string;
  label: string;
  description: string;
  icon: ReactNode;
  onSelect: () => void;
  /** When set, the item is shown but inactive and `description` explains why. */
  disabled?: boolean;
  tone?: "accent" | "danger" | "purple" | "green" | "orange" | "teal" | "yellow" | "plain";
}

/** Icon tile colours, after the system accent palette. */
const TILE: Record<NonNullable<ToolItem["tone"]>, string> = {
  accent: "bg-brand-500 text-white",
  danger: "bg-rose-400 text-white",
  purple: "bg-purple-brand text-white",
  green: "bg-ok text-white",
  orange: "bg-amber-warn text-white",
  teal: "bg-cyan-brand text-ink-900",
  yellow: "bg-[#ffd60a] text-ink-900",
  plain: "bg-ink-400 text-white",
};

/**
 * Everything you can do with one wallet, by name. Replaces a cluster of icon
 * buttons in the list: icons are fine once you know them, but a row of eight
 * unlabelled glyphs is a guessing game. Items are grouped like a macOS
 * inset list, and a disabled item says why instead of vanishing.
 */
export function ToolsDialog({
  title,
  subtitle,
  items,
  onClose,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  items: ToolItem[];
  onClose: () => void;
}) {
  const groups: [string, ToolItem[]][] = [];
  for (const item of items) {
    const g = groups.find(([name]) => name === item.group);
    if (g) g[1].push(item);
    else groups.push([item.group, [item]]);
  }

  return (
    <Modal title={title} onClose={onClose} width="max-w-md">
      {subtitle && <p className="mb-3 text-center font-mono text-[11px] text-mist-500">{subtitle}</p>}
      <div className="space-y-4">
        {groups.map(([name, list]) => (
          <section key={name}>
            <h3 className="mb-1 px-1 text-[11px] font-medium text-mist-500">{name}</h3>
            <ul className="divide-y divide-white/5 overflow-hidden rounded-lg bg-white/[0.06]">
              {list.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={item.onSelect}
                    disabled={item.disabled}
                    className={cx(
                      "flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors",
                      "hover:bg-white/10 focus-visible:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-500/60 focus-visible:ring-inset",
                      "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
                    )}
                  >
                    <span
                      className={cx(
                        "grid size-7 shrink-0 place-items-center rounded-md",
                        TILE[item.tone ?? "plain"],
                      )}
                    >
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cx(
                          "block text-[13px] font-medium",
                          item.tone === "danger" && !item.disabled && "text-rose-400",
                        )}
                      >
                        {item.label}
                      </span>
                      <span className="block text-[11px] leading-snug text-mist-500">
                        {item.description}
                      </span>
                    </span>
                    {!item.disabled && <span className="text-mist-500">›</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
