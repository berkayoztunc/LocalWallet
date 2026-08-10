//! RPC access. Everything network-facing goes through here so the endpoint,
//! commitment level and concurrency limit are applied in exactly one place.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::stream::{FuturesUnordered, StreamExt};
use serde::Serialize;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;

use crate::error::{AppError, Result};
use crate::settings::Settings;

/// `getMultipleAccounts` accepts at most 100 keys per call, so 200 wallets
/// cost two requests instead of two hundred.
const MAX_MULTIPLE_ACCOUNTS: usize = 100;

pub fn client(settings: &Settings) -> Arc<RpcClient> {
    let commitment = match settings.commitment.as_str() {
        "processed" => CommitmentConfig::processed(),
        "finalized" => CommitmentConfig::finalized(),
        _ => CommitmentConfig::confirmed(),
    };
    Arc::new(RpcClient::new_with_timeout_and_commitment(
        settings.rpc_url.clone(),
        Duration::from_secs(30),
        commitment,
    ))
}

pub fn rpc_err(e: impl std::fmt::Display) -> AppError {
    AppError::Rpc(e.to_string())
}

pub fn parse_pubkey(s: &str) -> Result<Pubkey> {
    s.trim()
        .parse::<Pubkey>()
        .map_err(|_| AppError::invalid(format!("not a valid Solana address: {s}")))
}

#[derive(Debug, Serialize)]
pub struct RpcHealth {
    pub ok: bool,
    pub version: Option<String>,
    pub latency_ms: u128,
    pub error: Option<String>,
}

/// Used by the Settings screen's "Test" button. Never returns `Err`: a broken
/// endpoint is a normal result here, reported in the payload.
pub async fn test_endpoint(url: &str) -> RpcHealth {
    let started = Instant::now();
    let rpc = RpcClient::new_with_timeout_and_commitment(
        url.to_string(),
        Duration::from_secs(10),
        CommitmentConfig::confirmed(),
    );
    match rpc.get_version().await {
        Ok(v) => {
            let healthy = rpc.get_health().await;
            RpcHealth {
                ok: healthy.is_ok(),
                version: Some(v.solana_core),
                latency_ms: started.elapsed().as_millis(),
                error: healthy.err().map(|e| e.to_string()),
            }
        }
        Err(e) => RpcHealth {
            ok: false,
            version: None,
            latency_ms: started.elapsed().as_millis(),
            error: Some(e.to_string()),
        },
    }
}

/// Fetch SOL balances for many wallets. Chunks of 100 are issued in parallel up
/// to `settings.concurrency`; a chunk that fails falls back to per-key
/// `getBalance` so one bad account cannot blank out 99 good ones.
pub async fn fetch_balances(
    rpc: Arc<RpcClient>,
    pubkeys: &[Pubkey],
    concurrency: usize,
) -> Vec<(Pubkey, Option<u64>)> {
    let chunks: Vec<Vec<Pubkey>> = pubkeys
        .chunks(MAX_MULTIPLE_ACCOUNTS)
        .map(|c| c.to_vec())
        .collect();

    let mut results: Vec<(Pubkey, Option<u64>)> = Vec::with_capacity(pubkeys.len());
    let mut pending = FuturesUnordered::new();
    let mut next = 0usize;

    let spawn = |rpc: Arc<RpcClient>, chunk: Vec<Pubkey>| async move {
        match rpc.get_multiple_accounts(&chunk).await {
            Ok(accounts) => chunk
                .iter()
                .zip(accounts)
                // A `None` account is a wallet that has never been funded (or
                // was drained to zero), which is a balance of 0, not an error.
                .map(|(pk, acc)| (*pk, Some(acc.map(|a| a.lamports).unwrap_or(0))))
                .collect::<Vec<_>>(),
            Err(_) => {
                let mut out = Vec::with_capacity(chunk.len());
                for pk in chunk {
                    out.push((pk, rpc.get_balance(&pk).await.ok()));
                }
                out
            }
        }
    };

    while next < chunks.len() && pending.len() < concurrency.max(1) {
        pending.push(spawn(rpc.clone(), chunks[next].clone()));
        next += 1;
    }
    while let Some(batch) = pending.next().await {
        results.extend(batch);
        if next < chunks.len() {
            pending.push(spawn(rpc.clone(), chunks[next].clone()));
            next += 1;
        }
    }
    results
}

/// Run `f` over every item with at most `concurrency` in flight. Used by sweep
/// and cleanup so 200 wallets do not open 200 simultaneous RPC connections.
pub async fn map_bounded<T, R, F, Fut>(items: Vec<T>, concurrency: usize, f: F) -> Vec<R>
where
    F: Fn(T) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let mut out = Vec::with_capacity(items.len());
    let mut iter = items.into_iter();
    let mut pending = FuturesUnordered::new();

    for _ in 0..concurrency.max(1) {
        match iter.next() {
            Some(item) => pending.push(f(item)),
            None => break,
        }
    }
    while let Some(res) = pending.next().await {
        out.push(res);
        if let Some(item) = iter.next() {
            pending.push(f(item));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pubkey_parsing_rejects_garbage() {
        assert!(parse_pubkey("11111111111111111111111111111111").is_ok());
        assert!(parse_pubkey("not-a-key").is_err());
    }

    #[tokio::test]
    async fn map_bounded_preserves_every_item() {
        let out = map_bounded((0..50).collect::<Vec<i32>>(), 8, |i| async move { i * 2 }).await;
        assert_eq!(out.len(), 50);
        let mut sorted = out;
        sorted.sort();
        assert_eq!(sorted.first(), Some(&0));
        assert_eq!(sorted.last(), Some(&98));
    }
}
