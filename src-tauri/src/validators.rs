//! The validator list.
//!
//! Two sources, deliberately unequal in authority:
//!
//! * **Your RPC** (`getVoteAccounts`) supplies every number that describes
//!   money — activated stake, commission, delinquency, vote credits. This is
//!   the truth the app reports.
//! * **A public directory** supplies human-readable decoration: name, icon,
//!   website, APY estimate. It is optional, cached, and its failure is never
//!   fatal — names simply fall back to vote addresses.
//!
//! A third-party server must never be the authority on what this app tells you
//! about your funds. It only makes the list readable.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use solana_client::nonblocking::rpc_client::RpcClient;
use tokio::sync::Mutex as AsyncMutex;

use crate::error::Result;
use crate::rpc;

/// Public validator directory. No API key, mainnet only.
const DIRECTORY_URL: &str = "https://api.stakewiz.com/validators";

/// The directory changes slowly (names, commissions, APY estimates), so one
/// fetch per session is plenty. Re-fetching per view would be 2 MB a time.
const DIRECTORY_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// Only the fields actually rendered are kept. The upstream response is ~2 MB
/// across 1,300 entries; trimming here keeps that out of the webview entirely.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ValidatorMeta {
    pub name: Option<String>,
    pub website: Option<String>,
    pub image: Option<String>,
    /// Estimated total APY as a percentage, directory's own estimate.
    pub apy: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct Validator {
    pub vote_pubkey: String,
    pub node_pubkey: String,
    /// Authoritative, from your RPC.
    pub activated_stake: u64,
    pub commission: u8,
    pub delinquent: bool,
    /// Credits earned in the most recent epoch the RPC reported.
    pub epoch_credits: u64,
    /// Decoration, from the directory. Absent when it is off or unreachable.
    #[serde(flatten)]
    pub meta: ValidatorMeta,
}

#[derive(Debug, Serialize)]
pub struct ValidatorList {
    pub validators: Vec<Validator>,
    pub total_active_stake: u64,
    pub delinquent_count: usize,
    /// True when names came from the directory; false means vote addresses
    /// only, either because it is disabled or because the fetch failed.
    pub directory_used: bool,
    /// Set when the directory was requested but did not answer, so the UI can
    /// say why names are missing instead of silently degrading.
    pub directory_error: Option<String>,
}

/// What the directory actually returns, narrowed to what we read.
#[derive(Deserialize)]
struct DirectoryEntry {
    vote_identity: String,
    name: Option<String>,
    website: Option<String>,
    image: Option<String>,
    total_apy: Option<f64>,
    apy_estimate: Option<f64>,
}

#[derive(Default)]
pub struct DirectoryCache {
    inner: AsyncMutex<Option<(HashMap<String, ValidatorMeta>, Instant)>>,
}

impl DirectoryCache {
    /// Fetch and trim the directory, reusing a cached copy inside the TTL.
    async fn get(&self) -> Result<HashMap<String, ValidatorMeta>> {
        let mut guard = self.inner.lock().await;
        if let Some((cached, at)) = guard.as_ref() {
            if at.elapsed() < DIRECTORY_TTL {
                return Ok(cached.clone());
            }
        }

        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("LocalWallet/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| crate::error::AppError::Rpc(e.to_string()))?
            .get(DIRECTORY_URL)
            .send()
            .await
            .map_err(|e| crate::error::AppError::Rpc(e.to_string()))?;

        let entries: Vec<DirectoryEntry> = response
            .json()
            .await
            .map_err(|e| crate::error::AppError::Rpc(e.to_string()))?;

        let map: HashMap<String, ValidatorMeta> = entries
            .into_iter()
            .map(|e| {
                (
                    e.vote_identity,
                    ValidatorMeta {
                        // Blank names are common; treat them as absent so the
                        // UI falls back to the address rather than showing "".
                        name: e.name.filter(|n| !n.trim().is_empty()),
                        website: e.website.filter(|w| !w.trim().is_empty()),
                        image: e.image.filter(|i| !i.trim().is_empty()),
                        apy: e.total_apy.or(e.apy_estimate),
                    },
                )
            })
            .collect();

        *guard = Some((map.clone(), Instant::now()));
        Ok(map)
    }
}

/// The validator list. `use_directory` false means zero third-party calls.
pub async fn list(
    rpc: Arc<RpcClient>,
    cache: &DirectoryCache,
    use_directory: bool,
) -> Result<ValidatorList> {
    let accounts = rpc.get_vote_accounts().await.map_err(rpc::rpc_err)?;

    // The directory is decoration: if it fails, report why and carry on with
    // the authoritative numbers rather than failing the whole list.
    let (meta, directory_error) = if use_directory {
        match cache.get().await {
            Ok(map) => (map, None),
            Err(e) => (HashMap::new(), Some(e.to_string())),
        }
    } else {
        (HashMap::new(), None)
    };

    let mut validators: Vec<Validator> = accounts
        .current
        .into_iter()
        .map(|v| (v, false))
        .chain(accounts.delinquent.into_iter().map(|v| (v, true)))
        .map(|(v, delinquent)| Validator {
            // `epoch_credits` is (epoch, credits, previous_credits); the
            // per-epoch figure is the delta, not the running total.
            epoch_credits: v
                .epoch_credits
                .last()
                .map(|(_, credits, previous)| credits.saturating_sub(*previous))
                .unwrap_or(0),
            meta: meta.get(&v.vote_pubkey).cloned().unwrap_or_default(),
            vote_pubkey: v.vote_pubkey,
            node_pubkey: v.node_pubkey,
            activated_stake: v.activated_stake,
            commission: v.commission,
            delinquent,
        })
        .collect();

    // Largest first: that is the order anyone browsing validators expects.
    validators.sort_by_key(|v| std::cmp::Reverse(v.activated_stake));

    Ok(ValidatorList {
        total_active_stake: validators
            .iter()
            .filter(|v| !v.delinquent)
            .map(|v| v.activated_stake)
            .sum(),
        delinquent_count: validators.iter().filter(|v| v.delinquent).count(),
        directory_used: use_directory && directory_error.is_none(),
        directory_error,
        validators,
    })
}
