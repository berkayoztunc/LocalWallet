import { openUrl } from "@tauri-apps/plugin-opener";
import { shortKey, toSol, type Settings, type WalletTokens } from "../lib/api";
import { tokenUrl } from "../lib/explorer";
import { Pill, Td, Th, cx } from "./ui";

/**
 * The expanded token inventory for one wallet: every token account it owns,
 * with balances so dust is visible.
 */
export function TokenRow({ tokens, settings }: { tokens: WalletTokens; settings: Settings }) {
  if (tokens.error) {
    return (
      <div className="border-y border-ink-600 bg-ink-950 px-4 py-3 text-xs text-rose-400">
        Could not scan: {tokens.error}
      </div>
    );
  }
  if (tokens.accounts.length === 0) {
    return (
      <div className="border-y border-ink-600 bg-ink-950 px-4 py-3 text-xs text-mist-500">
        No token accounts.
      </div>
    );
  }

  // Accounts holding something first — those are the ones worth acting on.
  const sorted = [...tokens.accounts].sort((a, b) => b.ui_amount - a.ui_amount);

  return (
    <div className="animate-fade-in border-y border-ink-600 bg-ink-950 px-4 py-3">
      <div className="mb-2 flex flex-wrap gap-x-1.5 text-[11px] text-mist-500">
        <span>
          {tokens.total_accounts} account{tokens.total_accounts === 1 ? "" : "s"}
        </span>
        <span>· {tokens.with_balance} with a balance</span>
        <span>· {tokens.empty_accounts} empty</span>
        <span>
          ·{" "}
          <span className="text-brand-300">{toSol(tokens.reclaimable_lamports)} SOL</span>{" "}
          reclaimable
        </span>
        {tokens.frozen_accounts > 0 && <span>· {tokens.frozen_accounts} frozen</span>}
        {tokens.locked_accounts > 0 && (
          <span
            className="text-magenta-brand"
            title="A third party holds close rights on these, so their rent cannot be reclaimed"
          >
            · {tokens.locked_accounts} locked
          </span>
        )}
      </div>

      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <Th className="!py-1 !text-[10px]">Mint</Th>
            <Th className="!py-1 !text-[10px]">Token account</Th>
            <Th numeric className="!py-1 !text-[10px]">
              Balance
            </Th>
            <Th className="!py-1 !text-[10px]">Program</Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((account) => (
            <tr key={account.address} className="border-t border-ink-800">
              <Td className="!py-1 font-mono">
                <button
                  className="rounded text-brand-500 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-500/40"
                  onClick={() => openUrl(tokenUrl(settings, account.mint))}
                >
                  {shortKey(account.mint)}
                </button>
              </Td>
              <Td className="!py-1 font-mono text-mist-500">{shortKey(account.address)}</Td>
              <Td
                numeric
                className={cx("!py-1 font-mono", account.amount === "0" ? "text-mist-500" : "text-mist-50")}
              >
                {account.ui_amount.toLocaleString(undefined, {
                  maximumFractionDigits: account.decimals,
                })}
              </Td>
              <Td className="!py-1">
                <Pill
                  tone={
                    account.frozen
                      ? "warn"
                      : account.close_authority
                        ? "magenta"
                        : account.program === "spl-token-2022"
                          ? "purple"
                          : undefined
                  }
                >
                  {account.frozen
                    ? "frozen"
                    : account.close_authority
                      ? "locked"
                      : account.program === "spl-token-2022"
                        ? "token-2022"
                        : "token"}
                </Pill>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
