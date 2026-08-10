import logoUrl from "../assets/logo-256.png";
import { cx } from "./ui";

/**
 * The app mark. Bundled through Vite so it is inlined into the build rather
 * than fetched at runtime — the artifact has no network access.
 */
export function Logo({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <img
      src={logoUrl}
      alt="LocalWallet"
      width={size}
      height={size}
      className={cx("object-contain select-none", className)}
      draggable={false}
    />
  );
}
