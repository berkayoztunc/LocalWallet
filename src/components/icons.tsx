/**
 * Inline stroke icons in the SF Symbols idiom (round caps and joins), sized
 * to the 13px UI scale.
 *
 * Hand-rolled rather than pulled from a library: the app ships offline, and a
 * dependency for eleven glyphs would cost more than it saves. Every icon draws
 * in `currentColor` so it inherits button state (hover, disabled, danger)
 * without any per-icon styling.
 */
type IconProps = { size?: number; className?: string };

function Svg({ size = 14, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Send — an outbound arrow. */
export function IconSend(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </Svg>
  );
}

/** Close token accounts — a box with its contents cleared out. */
export function IconClose(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 7h16v13H4z" />
      <path d="M4 7l2-3h12l2 3" />
      <path d="M10 13h4" />
    </Svg>
  );
}

/** Fund then close — coins going in. */
export function IconFund(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 4v9" />
      <path d="M8.5 9.5 12 13l3.5-3.5" />
      <path d="M4 16h16v4H4z" />
    </Svg>
  );
}

/** The funding wallet marker. Filled when active. */
export function IconStar({ filled, ...p }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...p}>
      <path
        d="M12 3.5l2.6 5.6 6 .8-4.4 4.2 1.1 6.1-5.3-3-5.3 3 1.1-6.1L3.4 9.9l6-.8z"
        fill={filled ? "currentColor" : "none"}
      />
    </Svg>
  );
}

/** Open in block explorer. */
export function IconExternal(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13 4h7v7" />
      <path d="M20 4l-9 9" />
      <path d="M19 14v6H4V5h6" />
    </Svg>
  );
}

/** Remove from vault. Destructive. */
export function IconTrash(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 6h16" />
      <path d="M6 6l1 14h10l1-14" />
      <path d="M9 6V3h6v3" />
    </Svg>
  );
}

export function IconCopy(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 8h12v12H8z" />
      <path d="M16 8V4H4v12h4" />
    </Svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 12.5 9 17.5 20 6.5" />
    </Svg>
  );
}

/** Password visible. */
export function IconEye(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </Svg>
  );
}

/** Password hidden. */
export function IconEyeOff(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.3 3.8" />
      <path d="M6.5 8.2A17 17 0 0 0 2 12s3.6 6 10 6a9.7 9.7 0 0 0 3.9-.8" />
    </Svg>
  );
}

/** Staked SOL — a stack of layers. */
export function IconStake(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3 3 7.5l9 4.5 9-4.5z" />
      <path d="M3 12.5 12 17l9-4.5" />
      <path d="M3 17 12 21.5 21 17" />
    </Svg>
  );
}

/** Begin cooldown on a stake account — a pause bar. */
export function IconUnstake(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 5v14" />
      <path d="M15 5v14" />
    </Svg>
  );
}

/** Withdraw a cooled-down stake back to the wallet — down to a baseline. */
export function IconWithdraw(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 4v10" />
      <path d="M7.5 9.5 12 14l4.5-4.5" />
      <path d="M5 19h14" />
    </Svg>
  );
}

/** A validator node. */
export function IconValidator(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 5h16v5H4z" />
      <path d="M4 14h16v5H4z" />
      <path d="M8 7.5h.01" />
      <path d="M8 16.5h.01" />
    </Svg>
  );
}

/** The vault, locked. Used on the unlock screen. */
export function IconLock(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 11h14v10H5z" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  );
}

/** Import — a tray with an arrow dropping in. */
export function IconImport(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 15v4h16v-4" />
      <path d="M12 4v11" />
      <path d="m8 11 4 4 4-4" />
    </Svg>
  );
}

/** Refresh balances — a circular arrow. */
export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v5h-5" />
    </Svg>
  );
}

/** Scan — a magnifying glass. */
export function IconScan(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </Svg>
  );
}

/** Collect all SOL — arrows converging on a tray. */
export function IconCollect(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 15v4h16v-4" />
      <path d="M12 3v10" />
      <path d="m8 9 4 4 4-4" />
      <path d="M8 19h8" />
    </Svg>
  );
}

/** Settings — a gear. */
export function IconGear(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
    </Svg>
  );
}

/** Fees & locks — a coin. */
export function IconCoin(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.5 9.2c-.4-.8-1.4-1.2-2.5-1.2-1.5 0-2.5.8-2.5 1.8 0 2.4 5 1.2 5 3.6 0 1-1.1 1.8-2.5 1.8-1.2 0-2.2-.5-2.6-1.3" />
      <path d="M12 6.5V8m0 8v1.5" />
    </Svg>
  );
}

/** Search field glyph. */
export function IconSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6" />
      <path d="m15.5 15.5 4 4" />
    </Svg>
  );
}

/** Touch ID — a fingerprint. */
export function IconFingerprint(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 8.5A8.5 8.5 0 0 1 12 4.5a8.5 8.5 0 0 1 7.5 4" />
      <path d="M6.5 18.5c-1-1.6-1.5-3.5-1.5-5.5a7 7 0 0 1 14 0c0 1.2-.1 2.3-.4 3.4" />
      <path d="M9 20.5c-.9-1.8-1.3-3.6-1.3-5.5a4.3 4.3 0 0 1 8.6 0c0 1.7-.2 3.3-.7 4.8" />
      <path d="M12 13v2c0 1.8.3 3.5 1 5" />
    </Svg>
  );
}

/** Export private key — a key. */
export function IconKey(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="15" r="3.5" />
      <path d="m10.5 12.5 8-8" />
      <path d="M15 8l2.5 2.5" />
      <path d="M17.5 5.5 20 8" />
    </Svg>
  );
}
