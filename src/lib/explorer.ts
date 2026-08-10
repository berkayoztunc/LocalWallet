import type { Settings } from "./api";

/**
 * The single place explorer URLs are built. Every link in the app routes
 * through here so the user's choice is honoured everywhere, and so a
 * mainnet-only explorer can never be handed a devnet address.
 *
 * URL schemes verified against the live sites; `orb.helius.dev` now
 * 308-redirects to `orbmarkets.io` with the path preserved, so we link the
 * canonical host directly and skip the hop.
 */
export type ExplorerId = "solana-explorer" | "solscan" | "orb";
export type Cluster = "mainnet" | "devnet" | "testnet";

export interface ExplorerInfo {
  id: ExplorerId;
  name: string;
  host: string;
  /** Explorers with no cluster parameter only ever show mainnet data. */
  mainnetOnly: boolean;
}

export const EXPLORERS: ExplorerInfo[] = [
  {
    id: "solana-explorer",
    name: "Solana Explorer",
    host: "explorer.solana.com",
    mainnetOnly: false,
  },
  { id: "solscan", name: "Solscan", host: "solscan.io", mainnetOnly: false },
  { id: "orb", name: "Orb", host: "orbmarkets.io", mainnetOnly: true },
];

export function explorerInfo(id: string): ExplorerInfo {
  return EXPLORERS.find((e) => e.id === id) ?? EXPLORERS[0];
}

/** Best-effort cluster detection from the RPC URL; unknown hosts are mainnet. */
export function clusterFromRpc(rpcUrl: string): Cluster {
  const url = rpcUrl.toLowerCase();
  if (url.includes("devnet")) return "devnet";
  if (url.includes("testnet")) return "testnet";
  return "mainnet";
}

type Kind = "address" | "tx" | "token";

function path(id: ExplorerId, kind: Kind, value: string): string {
  switch (id) {
    case "solscan":
      // Solscan splits wallets from token mints; the others do not.
      return kind === "address"
        ? `/account/${value}`
        : kind === "token"
          ? `/token/${value}`
          : `/tx/${value}`;
    case "orb":
      return kind === "token" ? `/token/${value}` : `/${kind}/${value}`;
    case "solana-explorer":
    default:
      // Solana Explorer has no dedicated token route; mints are addresses.
      return kind === "tx" ? `/tx/${value}` : `/address/${value}`;
  }
}

function clusterQuery(cluster: Cluster): string {
  if (cluster === "mainnet") return "";
  // Both cluster-aware explorers use the same parameter name.
  return `?cluster=${cluster}`;
}

function build(settings: Settings, kind: Kind, value: string): string {
  const cluster = clusterFromRpc(settings.rpc_url);
  let info = explorerInfo(settings.explorer);

  // A mainnet-only explorer would render a confusing empty page for a devnet
  // address, so fall back to one that understands clusters.
  if (info.mainnetOnly && cluster !== "mainnet") {
    info = EXPLORERS[0];
  }

  return `https://${info.host}${path(info.id, kind, value)}${clusterQuery(cluster)}`;
}

export function addressUrl(settings: Settings, address: string): string {
  return build(settings, "address", address);
}

export function txUrl(settings: Settings, signature: string): string {
  return build(settings, "tx", signature);
}

export function tokenUrl(settings: Settings, mint: string): string {
  return build(settings, "token", mint);
}

/** True when the chosen explorer cannot show the cluster the RPC points at. */
export function explorerFallsBack(settings: Settings): boolean {
  return (
    explorerInfo(settings.explorer).mainnetOnly &&
    clusterFromRpc(settings.rpc_url) !== "mainnet"
  );
}
