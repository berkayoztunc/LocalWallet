//! Read-only position scans: Pump.fun creator fees and Streamflow locks.
//!
//! Nothing here signs or sends a transaction. Only wallet addresses and labels
//! are read from the signing keys.
//!
//! * **Pump.fun** creator fees accumulate in PDAs derived from the creator
//!   wallet, so they are found by deriving the addresses and reading them in
//!   batches. Two places are checked: the bonding-curve vault (native SOL) and
//!   the Pump AMM vault (WSOL, after a token migrates). Seeds were read off the
//!   program IDLs via Orquestra (`collect_creator_fee`, `coin_creator_vault_*`).
//!   Fees routed through a fee-sharing config go to shareholders instead and are
//!   not detected here.
//! * **Streamflow** contracts are looked up through Streamflow's public API
//!   (`recipient` filter, no key needed). The on-chain account layout is not
//!   used: it is hard to verify without a real stream, and the API already
//!   returns decoded amounts. The tradeoff is that wallet addresses are sent to
//!   `api-public.streamflow.finance`, so the UI makes this an explicit action.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_config::{
    RpcAccountInfoConfig, RpcProgramAccountsConfig, UiAccountEncoding, UiDataSliceConfig,
};
use solana_client::rpc_filter::{Memcmp, RpcFilterType};
use solana_sdk::account::Account;
use solana_sdk::pubkey::Pubkey;

use crate::error::Result;
use crate::rpc;
use crate::state::SigningKey;

const PUMP_PROGRAM_ID: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM_PROGRAM_ID: &str = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM_ID: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const STREAMFLOW_API: &str = "https://api-public.streamflow.finance/v2/api/contracts/tabularium/";

const STREAMFLOW_PROGRAM_ID: &str = "strmdbLr6w7QNmsiEXyFwWg3VSfg1GiELgU27P8aCGw";
/// Size of a Streamflow contract account, and where its `recipient` sits
/// (magic 8 + version 1 + five u64 timestamps/amounts 40 + sender 32 +
/// sender_tokens 32). The offset was confirmed live: a memcmp at 113 returned
/// exactly the accounts whose recipient matched.
const STREAMFLOW_ACCOUNT_LEN: u64 = 1104;
const STREAMFLOW_RECIPIENT_OFFSET: usize = 113;
/// Pause between API calls. The API rate-limits hard (HTTP 420 with a
/// Retry-After of about an hour), so it is called sequentially and only for
/// wallets that actually have a contract.
const STREAMFLOW_CALL_GAP: Duration = Duration::from_millis(400);

const MAX_MULTIPLE_ACCOUNTS: usize = 100;

fn pk(s: &str) -> Pubkey {
    Pubkey::from_str(s).unwrap()
}

/* ------------------------------ output types ------------------------------ */

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PumpFee {
    pub owner_pubkey: String,
    pub owner_label: String,
    /// Bonding-curve creator vault PDA.
    pub vault: String,
    /// Claimable native SOL in the bonding-curve vault (rent excluded).
    pub sol_lamports: u64,
    /// Pump AMM vault's WSOL token account.
    pub amm_vault: String,
    /// Claimable WSOL (lamports) in the AMM vault.
    pub amm_lamports: u64,
    /// Unix seconds of the scan that produced this row.
    #[serde(default)]
    pub scanned_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StreamPosition {
    pub owner_pubkey: String,
    pub owner_label: String,
    pub address: String,
    /// "VESTING" | "TOKEN_LOCK" | "DYNAMIC_VESTING" | "DYNAMIC_LOCK"
    pub contract_type: String,
    pub name: String,
    pub sender: String,
    pub mint: String,
    pub decimals: Option<u8>,
    /// Base units as decimal strings; token amounts can exceed 2^53.
    pub total: String,
    pub claimed: String,
    pub locked: String,
    /// Set only when everything left is claimable now. Partial unlocks of a
    /// running stream are not computed here: the API gives no cliff time, and
    /// guessing would show wrong money.
    pub withdrawable: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
    pub paused: bool,
    /// Unix seconds of the scan that produced this row.
    #[serde(default)]
    pub scanned_at: i64,
}

/// What the UI shows for the Pump.fun tab: the saved rows plus this run's
/// problems, so a partial scan is never read as "nothing".
#[derive(Debug, Serialize)]
pub struct PumpView {
    pub rows: Vec<PumpFee>,
    pub total_lamports: u64,
    pub last_scan_at: Option<i64>,
    /// When each wallet was last checked, including wallets with nothing to
    /// show. This is what lets a rescan skip wallets that are still fresh.
    pub checked: HashMap<String, i64>,
    /// Wallets left out of this run because they were checked recently.
    pub skipped_fresh: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct StreamsView {
    pub rows: Vec<StreamPosition>,
    pub last_scan_at: Option<i64>,
    pub checked: HashMap<String, i64>,
    pub skipped_fresh: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PositionsCache {
    pub pump: PumpView,
    pub streams: StreamsView,
}

/* ------------------------------- Pump.fun -------------------------------- */

pub fn pump_creator_vault(creator: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"creator-vault", creator.as_ref()], &pk(PUMP_PROGRAM_ID)).0
}

/// The Pump AMM vault authority and its WSOL associated token account.
pub fn amm_vault_ata(creator: &Pubkey) -> (Pubkey, Pubkey) {
    let authority = Pubkey::find_program_address(
        &[b"creator_vault", creator.as_ref()],
        &pk(PUMP_AMM_PROGRAM_ID),
    )
    .0;
    let ata = Pubkey::find_program_address(
        &[
            authority.as_ref(),
            pk(TOKEN_PROGRAM_ID).as_ref(),
            pk(WSOL_MINT).as_ref(),
        ],
        &pk(ATA_PROGRAM_ID),
    )
    .0;
    (authority, ata)
}

/// `amount` of an SPL token account: a little-endian u64 at byte 64.
fn token_account_amount(account: &Account) -> u64 {
    if account.owner != pk(TOKEN_PROGRAM_ID) || account.data.len() < 72 {
        return 0;
    }
    u64::from_le_bytes(account.data[64..72].try_into().unwrap())
}

async fn fetch_chunked(
    rpc: &Arc<RpcClient>,
    keys: Vec<Pubkey>,
    concurrency: usize,
) -> (Vec<Option<Account>>, Vec<String>) {
    let chunks: Vec<(usize, Vec<Pubkey>)> = keys
        .chunks(MAX_MULTIPLE_ACCOUNTS)
        .map(|c| c.to_vec())
        .enumerate()
        .collect();
    let sizes: Vec<usize> = chunks.iter().map(|(_, c)| c.len()).collect();

    let mut results = rpc::map_bounded(chunks, concurrency, |(idx, chunk)| {
        let rpc = rpc.clone();
        async move {
            (
                idx,
                rpc.get_multiple_accounts(&chunk)
                    .await
                    .map_err(|e| e.to_string()),
            )
        }
    })
    .await;
    // map_bounded completes out of order; put the chunks back in sequence.
    results.sort_by_key(|(idx, _)| *idx);

    let mut out = Vec::with_capacity(keys.len());
    let mut errors = Vec::new();
    for (idx, res) in results {
        match res {
            Ok(accounts) => out.extend(accounts),
            Err(e) => {
                errors.push(e);
                out.extend(std::iter::repeat_with(|| None).take(sizes[idx]));
            }
        }
    }
    (out, errors)
}

async fn scan_pump(
    rpc: &Arc<RpcClient>,
    wallets: &[(Pubkey, String)],
    concurrency: usize,
) -> (Vec<PumpFee>, Vec<String>) {
    let mut keys = Vec::with_capacity(wallets.len() * 2);
    let mut derived = Vec::with_capacity(wallets.len());
    for (owner, _) in wallets {
        let vault = pump_creator_vault(owner);
        let (_, ata) = amm_vault_ata(owner);
        keys.push(vault);
        keys.push(ata);
        derived.push((vault, ata));
    }

    let (accounts, fetch_errors) = fetch_chunked(rpc, keys, concurrency).await;
    let mut errors: Vec<String> = fetch_errors
        .into_iter()
        .map(|e| format!("Pump.fun lookup failed for part of the wallets: {e}"))
        .collect();

    // A vault account must keep its rent-exempt minimum, so only the excess is
    // claimable. Every vault has the same size; look each distinct size up once.
    let mut rent_by_len: HashMap<usize, u64> = HashMap::new();
    let lens: BTreeSet<usize> = accounts
        .iter()
        .step_by(2)
        .flatten()
        .map(|a| a.data.len())
        .collect();
    for len in lens {
        match rpc.get_minimum_balance_for_rent_exemption(len).await {
            Ok(r) => {
                rent_by_len.insert(len, r);
            }
            Err(e) => errors.push(format!("rent lookup failed: {e}")),
        }
    }

    let scanned_at = chrono::Utc::now().timestamp();
    let mut found = Vec::new();
    for (i, ((owner, label), (vault, ata))) in wallets.iter().zip(derived).enumerate() {
        let sol = match &accounts[i * 2] {
            Some(acc) if acc.owner == pk(PUMP_PROGRAM_ID) => match rent_by_len.get(&acc.data.len())
            {
                Some(rent) => acc.lamports.saturating_sub(*rent),
                // Unknown rent: report nothing rather than overstate it.
                None => 0,
            },
            _ => 0,
        };
        let amm = accounts[i * 2 + 1]
            .as_ref()
            .map(token_account_amount)
            .unwrap_or(0);
        if sol > 0 || amm > 0 {
            found.push(PumpFee {
                owner_pubkey: owner.to_string(),
                owner_label: label.clone(),
                vault: vault.to_string(),
                sol_lamports: sol,
                amm_vault: ata.to_string(),
                amm_lamports: amm,
                scanned_at,
            });
        }
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.sol_lamports + f.amm_lamports));
    (found, errors)
}

/* ------------------------------- Streamflow ------------------------------ */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiContract {
    address: String,
    #[serde(default)]
    chain: String,
    #[serde(default)]
    contract_type: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    sender: String,
    mint: String,
    amount: String,
    #[serde(default)]
    claimed_amount: String,
    start_dt: Option<String>,
    end_dt: Option<String>,
    canceled_dt: Option<String>,
    paused_dt: Option<String>,
    #[serde(default)]
    is_closed: bool,
}

fn parse_amount(s: &str) -> u128 {
    s.trim().parse().unwrap_or(0)
}

fn parse_time(s: &Option<String>) -> Option<chrono::DateTime<chrono::Utc>> {
    s.as_deref()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&chrono::Utc))
}

/// Turn an API contract into a position, or `None` if nothing is left locked
/// (closed, canceled, fully claimed, or not on Solana).
fn to_position(
    c: ApiContract,
    owner: &str,
    label: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<StreamPosition> {
    if !c.chain.eq_ignore_ascii_case("solana") || c.is_closed || c.canceled_dt.is_some() {
        return None;
    }
    let total = parse_amount(&c.amount);
    let claimed = parse_amount(&c.claimed_amount);
    let locked = total.saturating_sub(claimed);
    if locked == 0 {
        return None;
    }
    let paused = c.paused_dt.is_some();
    let ended = parse_time(&c.end_dt).map(|e| e <= now).unwrap_or(false);
    Some(StreamPosition {
        owner_pubkey: owner.to_string(),
        owner_label: label.to_string(),
        address: c.address,
        contract_type: c.contract_type,
        name: c.name,
        sender: c.sender,
        mint: c.mint,
        decimals: None,
        total: total.to_string(),
        claimed: claimed.to_string(),
        locked: locked.to_string(),
        withdrawable: (ended && !paused).then(|| locked.to_string()),
        start: c.start_dt,
        end: c.end_dt,
        paused,
        scanned_at: now.timestamp(),
    })
}

/// Does this wallet receive any Streamflow contract? One cheap `getProgramAccounts`
/// with a zero-length data slice. `None` when the RPC refuses the query, in which
/// case the caller falls back to asking the API.
async fn has_streamflow_contract(rpc: &RpcClient, owner: &Pubkey) -> Option<bool> {
    let config = RpcProgramAccountsConfig {
        filters: Some(vec![
            RpcFilterType::DataSize(STREAMFLOW_ACCOUNT_LEN),
            RpcFilterType::Memcmp(Memcmp::new_base58_encoded(
                STREAMFLOW_RECIPIENT_OFFSET,
                owner.as_ref(),
            )),
        ]),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            data_slice: Some(UiDataSliceConfig {
                offset: 0,
                length: 0,
            }),
            commitment: None,
            min_context_slot: None,
        },
        with_context: None,
        sort_results: None,
    };
    rpc.get_program_ui_accounts_with_config(&pk(STREAMFLOW_PROGRAM_ID), config)
        .await
        .ok()
        .map(|accounts| !accounts.is_empty())
}

/// Seconds to wait before retrying, from a `Retry-After` header.
fn retry_after_secs(value: Option<&str>) -> Option<u64> {
    value.and_then(|v| v.trim().parse().ok())
}

fn rate_limit_message(retry_after: Option<u64>, skipped: usize) -> String {
    let when = match retry_after {
        Some(s) if s >= 90 => format!(" Try again in about {} min.", s.div_ceil(60)),
        Some(s) => format!(" Try again in about {s} s."),
        None => String::new(),
    };
    format!(
        "Streamflow rate-limited this scan; {skipped} wallet(s) with contracts were not checked.{when}"
    )
}

async fn scan_streamflow(
    rpc: &Arc<RpcClient>,
    wallets: &[(Pubkey, String)],
    concurrency: usize,
) -> (Vec<StreamPosition>, Vec<String>, Vec<String>) {
    let http = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("LocalWallet")
        .build()
    {
        Ok(c) => c,
        Err(e) => return (vec![], vec![format!("Streamflow: {e}")], vec![]),
    };
    let now = chrono::Utc::now();

    // Step 1, on-chain: which wallets have any contract at all? Most have none,
    // and every wallet skipped here is an API call not made.
    let inputs: Vec<(Pubkey, String)> = wallets.to_vec();
    let probed = rpc::map_bounded(inputs, concurrency, |(owner, label)| {
        let rpc = rpc.clone();
        async move {
            let hit = has_streamflow_contract(&rpc, &owner).await;
            (owner, label, hit)
        }
    })
    .await;
    // Wallets proven to have no contract are fully checked already. An
    // unknown answer (RPC refused) counts as a candidate: better one extra API
    // call than a missed lock.
    let mut checked: Vec<String> = probed
        .iter()
        .filter(|(_, _, hit)| *hit == Some(false))
        .map(|(o, _, _)| o.to_string())
        .collect();
    let mut candidates: Vec<(Pubkey, String)> = probed
        .into_iter()
        .filter(|(_, _, hit)| *hit != Some(false))
        .map(|(o, l, _)| (o, l))
        .collect();
    candidates.sort_by_key(|(o, _)| o.to_string());

    // Step 2, API: sequential and slow, stopping at the first rate limit.
    let mut streams = Vec::new();
    let mut errors = Vec::new();
    for (i, (owner, label)) in candidates.iter().enumerate() {
        let owner_s = owner.to_string();
        let resp = http
            .get(STREAMFLOW_API)
            .query(&[("recipient", owner_s.as_str())])
            .send()
            .await;
        match resp {
            Ok(r) if r.status().as_u16() == 420 || r.status().as_u16() == 429 => {
                let wait =
                    retry_after_secs(r.headers().get("retry-after").and_then(|v| v.to_str().ok()));
                errors.push(rate_limit_message(wait, candidates.len() - i));
                break;
            }
            Ok(r) => match r.error_for_status() {
                Ok(r) => match r.json::<Vec<ApiContract>>().await {
                    Ok(list) => {
                        streams.extend(
                            list.into_iter()
                                .filter_map(|c| to_position(c, &owner_s, label, now)),
                        );
                        checked.push(owner_s.clone());
                    }
                    Err(e) => errors.push(format!("Streamflow {owner_s}: {e}")),
                },
                Err(e) => errors.push(format!("Streamflow {owner_s}: {e}")),
            },
            Err(e) => errors.push(format!("Streamflow {owner_s}: {e}")),
        }
        tokio::time::sleep(STREAMFLOW_CALL_GAP).await;
    }
    streams.sort_by(|a, b| a.owner_pubkey.cmp(&b.owner_pubkey).then(a.end.cmp(&b.end)));
    (streams, errors, checked)
}

/// Fill in token decimals from the mint accounts (byte 44 of an SPL mint).
async fn attach_decimals(rpc: &Arc<RpcClient>, streams: &mut [StreamPosition], concurrency: usize) {
    let mints: Vec<Pubkey> = streams
        .iter()
        .map(|s| s.mint.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|m| Pubkey::from_str(&m).ok())
        .collect();
    if mints.is_empty() {
        return;
    }
    let (accounts, _) = fetch_chunked(rpc, mints.clone(), concurrency).await;
    let decimals: HashMap<String, u8> = mints
        .iter()
        .zip(accounts)
        .filter_map(|(m, a)| {
            let a = a?;
            (a.data.len() >= 45).then(|| (m.to_string(), a.data[44]))
        })
        .collect();
    for s in streams {
        s.decimals = decimals.get(&s.mint).copied();
    }
}

/* --------------------------- persistence + entry -------------------------- */

/// The last scan of each tab, kept on disk so the modal opens with the previous
/// results. Rows carry their own `scanned_at`, and a scan replaces only the
/// wallets it actually managed to check, so a rate-limited run never wipes
/// rows it could not refresh. Holds wallet addresses and labels, no keys.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Cache {
    #[serde(default)]
    pump: Vec<PumpFee>,
    #[serde(default)]
    pump_at: Option<i64>,
    #[serde(default)]
    streams: Vec<StreamPosition>,
    #[serde(default)]
    streams_at: Option<i64>,
    #[serde(default)]
    pump_checked: HashMap<String, i64>,
    #[serde(default)]
    streams_checked: HashMap<String, i64>,
}

fn cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join("positions.json")
}

fn load_cache(data_dir: &Path) -> Cache {
    std::fs::read(cache_path(data_dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_cache(data_dir: &Path, cache: &Cache) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = cache_path(data_dir);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(cache)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Drop saved rows for every wallet that was just re-checked, then add the
/// fresh ones. Wallets that were not checked keep their old rows.
fn merge<T>(
    mut old: Vec<T>,
    fresh: Vec<T>,
    checked: &HashSet<String>,
    owner: impl Fn(&T) -> &str,
) -> Vec<T> {
    old.retain(|r| !checked.contains(owner(r)));
    old.extend(fresh);
    old
}

fn pump_view(cache: &Cache, skipped_fresh: usize, errors: Vec<String>) -> PumpView {
    PumpView {
        total_lamports: cache
            .pump
            .iter()
            .map(|f| f.sol_lamports + f.amm_lamports)
            .sum(),
        rows: cache.pump.clone(),
        last_scan_at: cache.pump_at,
        checked: cache.pump_checked.clone(),
        skipped_fresh,
        errors,
    }
}

fn streams_view(cache: &Cache, skipped_fresh: usize, errors: Vec<String>) -> StreamsView {
    StreamsView {
        rows: cache.streams.clone(),
        last_scan_at: cache.streams_at,
        checked: cache.streams_checked.clone(),
        skipped_fresh,
        errors,
    }
}

/// Keep only wallets not checked within `max_age_secs`. `None` keeps all, which
/// is what an explicit "rescan" wants.
fn stale_only(
    wallets: Vec<(Pubkey, String)>,
    checked: &HashMap<String, i64>,
    max_age_secs: Option<i64>,
    now: i64,
) -> (Vec<(Pubkey, String)>, usize) {
    let Some(max_age) = max_age_secs else {
        return (wallets, 0);
    };
    let before = wallets.len();
    let kept: Vec<_> = wallets
        .into_iter()
        .filter(|(p, _)| {
            checked
                .get(&p.to_string())
                .is_none_or(|t| now - t >= max_age)
        })
        .collect();
    let skipped = before - kept.len();
    (kept, skipped)
}

pub fn load(data_dir: &Path) -> PositionsCache {
    let cache = load_cache(data_dir);
    PositionsCache {
        pump: pump_view(&cache, 0, vec![]),
        streams: streams_view(&cache, 0, vec![]),
    }
}

fn wallet_list(keys: &[SigningKey]) -> (Vec<(Pubkey, String)>, Vec<String>) {
    let mut wallets = Vec::with_capacity(keys.len());
    let mut errors = Vec::new();
    for k in keys {
        match rpc::parse_pubkey(&k.pubkey) {
            Ok(p) => wallets.push((p, k.label.clone())),
            Err(e) => errors.push(format!("{}: {e}", k.pubkey)),
        }
    }
    (wallets, errors)
}

/// Pump.fun creator fees only. Independent of the Streamflow scan.
/// `max_age_secs` skips wallets checked more recently than that.
pub async fn scan_pump_fees(
    data_dir: &Path,
    rpc: Arc<RpcClient>,
    keys: &[SigningKey],
    concurrency: usize,
    max_age_secs: Option<i64>,
) -> Result<PumpView> {
    let (wallets, mut errors) = wallet_list(keys);
    let mut cache = load_cache(data_dir);
    let now = chrono::Utc::now().timestamp();
    let (wallets, skipped) = stale_only(wallets, &cache.pump_checked, max_age_secs, now);
    if wallets.is_empty() {
        return Ok(pump_view(&cache, skipped, errors));
    }

    let (fresh, pump_err) = scan_pump(&rpc, &wallets, concurrency).await;
    // A lookup that failed part-way cannot say which wallets were covered, so
    // it refreshes nothing rather than erasing good rows.
    if pump_err.is_empty() {
        let checked: HashSet<String> = wallets.iter().map(|(p, _)| p.to_string()).collect();
        cache.pump = merge(std::mem::take(&mut cache.pump), fresh, &checked, |r| {
            &r.owner_pubkey
        });
        cache
            .pump
            .sort_by_key(|f| std::cmp::Reverse(f.sol_lamports + f.amm_lamports));
        for pk in checked {
            cache.pump_checked.insert(pk, now);
        }
        cache.pump_at = Some(now);
        save_cache(data_dir, &cache)?;
    }
    errors.extend(pump_err);
    Ok(pump_view(&cache, skipped, errors))
}

/// Streamflow locks only. Independent of the Pump.fun scan.
pub async fn scan_streams(
    data_dir: &Path,
    rpc: Arc<RpcClient>,
    keys: &[SigningKey],
    concurrency: usize,
    max_age_secs: Option<i64>,
) -> Result<StreamsView> {
    let (wallets, mut errors) = wallet_list(keys);
    let mut cache = load_cache(data_dir);
    let now = chrono::Utc::now().timestamp();
    let (wallets, skipped) = stale_only(wallets, &cache.streams_checked, max_age_secs, now);
    if wallets.is_empty() {
        return Ok(streams_view(&cache, skipped, errors));
    }

    let (mut fresh, sf_err, checked) = scan_streamflow(&rpc, &wallets, concurrency).await;
    attach_decimals(&rpc, &mut fresh, concurrency).await;

    if !checked.is_empty() {
        let checked: HashSet<String> = checked.into_iter().collect();
        cache.streams = merge(std::mem::take(&mut cache.streams), fresh, &checked, |r| {
            &r.owner_pubkey
        });
        cache
            .streams
            .sort_by(|a, b| a.owner_pubkey.cmp(&b.owner_pubkey).then(a.end.cmp(&b.end)));
        for pk in checked {
            cache.streams_checked.insert(pk, now);
        }
        cache.streams_at = Some(now);
        save_cache(data_dir, &cache)?;
    }
    errors.extend(sf_err);
    Ok(streams_view(&cache, skipped, errors))
}

/// Forget what was saved for some wallets, in one tab or both. The next scan
/// treats them as never checked.
pub fn forget(data_dir: &Path, which: &str, pubkeys: &[String]) -> Result<PositionsCache> {
    let mut cache = load_cache(data_dir);
    let set: HashSet<&str> = pubkeys.iter().map(|s| s.as_str()).collect();
    if which != "streams" {
        cache
            .pump
            .retain(|r| !set.contains(r.owner_pubkey.as_str()));
        cache.pump_checked.retain(|k, _| !set.contains(k.as_str()));
    }
    if which != "pump" {
        cache
            .streams
            .retain(|r| !set.contains(r.owner_pubkey.as_str()));
        cache
            .streams_checked
            .retain(|k, _| !set.contains(k.as_str()));
    }
    save_cache(data_dir, &cache)?;
    Ok(PositionsCache {
        pump: pump_view(&cache, 0, vec![]),
        streams: streams_view(&cache, 0, vec![]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn contract(json: &str) -> ApiContract {
        serde_json::from_str(json).unwrap()
    }

    // Shape copied from a live api-public.streamflow.finance response.
    const LIVE: &str = r#"{"address":"5bV9","chain":"SOLANA","contractType":"VESTING",
        "name":"","sender":"S","mint":"ZEUS","amount":"3000000","cliffAmount":"0",
        "amountPerPeriod":"1500000","claimedAmount":"1000000","period":1209600,
        "startDt":"2024-12-05T21:12:16Z","endDt":"2025-01-02T21:12:16Z",
        "canceledDt":null,"pausedDt":null,"isClosed":false,"extraFieldWeIgnore":1}"#;

    #[test]
    fn running_stream_is_locked_but_not_withdrawable() {
        let now = Utc.with_ymd_and_hms(2024, 12, 20, 0, 0, 0).unwrap();
        let p = to_position(contract(LIVE), "O", "w", now).unwrap();
        assert_eq!(p.locked, "2000000");
        assert_eq!(p.withdrawable, None);
    }

    #[test]
    fn ended_stream_is_fully_withdrawable() {
        let now = Utc.with_ymd_and_hms(2025, 2, 1, 0, 0, 0).unwrap();
        let p = to_position(contract(LIVE), "O", "w", now).unwrap();
        assert_eq!(p.withdrawable.as_deref(), Some("2000000"));
    }

    #[test]
    fn done_canceled_and_foreign_contracts_are_dropped() {
        let now = Utc.with_ymd_and_hms(2025, 2, 1, 0, 0, 0).unwrap();
        let done = LIVE.replace(
            "\"claimedAmount\":\"1000000\"",
            "\"claimedAmount\":\"3000000\"",
        );
        assert!(to_position(contract(&done), "O", "w", now).is_none());
        let closed = LIVE.replace("\"isClosed\":false", "\"isClosed\":true");
        assert!(to_position(contract(&closed), "O", "w", now).is_none());
        let canceled = LIVE.replace(
            "\"canceledDt\":null",
            "\"canceledDt\":\"2025-01-01T00:00:00Z\"",
        );
        assert!(to_position(contract(&canceled), "O", "w", now).is_none());
        let eth = LIVE.replace("\"SOLANA\"", "\"ETHEREUM\"");
        assert!(to_position(contract(&eth), "O", "w", now).is_none());
    }

    #[test]
    fn merge_replaces_checked_wallets_and_keeps_the_rest() {
        let checked: HashSet<String> = ["A".to_string()].into();
        let old = vec![("A", 1), ("B", 2)];
        // A was re-checked and now has no row; B was not checked, so it stays.
        assert_eq!(
            merge(old.clone(), vec![], &checked, |r| r.0),
            vec![("B", 2)]
        );
        // A re-checked with a fresh row replaces the stale one.
        assert_eq!(
            merge(old, vec![("A", 9)], &checked, |r| r.0),
            vec![("B", 2), ("A", 9)]
        );
    }

    #[test]
    fn stale_only_skips_fresh_wallets() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let c = Pubkey::new_unique();
        let wallets = vec![(a, "a".into()), (b, "b".into()), (c, "c".into())];
        let mut checked = HashMap::new();
        checked.insert(a.to_string(), 1_000); // 100 s old: fresh
        checked.insert(b.to_string(), 100); // 1000 s old: stale
                                            // c was never checked
        let (kept, skipped) = stale_only(wallets.clone(), &checked, Some(300), 1_100);
        assert_eq!(skipped, 1);
        assert_eq!(
            kept.iter().map(|k| k.1.as_str()).collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        // None = force everything.
        let (all, none) = stale_only(wallets, &checked, None, 1_100);
        assert_eq!((all.len(), none), (3, 0));
    }

    #[test]
    fn forget_clears_rows_and_check_times() {
        let dir = std::env::temp_dir().join("lw-positions-forget");
        let _ = std::fs::remove_dir_all(&dir);
        let mut c = Cache::default();
        c.pump_checked.insert("A".into(), 1);
        c.pump_checked.insert("B".into(), 1);
        c.streams_checked.insert("A".into(), 1);
        save_cache(&dir, &c).unwrap();
        let v = forget(&dir, "pump", &["A".to_string()]).unwrap();
        assert!(!v.pump.checked.contains_key("A"));
        assert!(v.pump.checked.contains_key("B"));
        assert!(v.streams.checked.contains_key("A")); // other tab untouched
        let v = forget(&dir, "all", &["A".to_string()]).unwrap();
        assert!(v.streams.checked.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cache_round_trips_and_tolerates_old_files() {
        let dir = std::env::temp_dir().join("lw-positions-test");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load_cache(&dir).pump.is_empty());
        let c = Cache {
            pump_at: Some(5),
            ..Cache::default()
        };
        save_cache(&dir, &c).unwrap();
        assert_eq!(load_cache(&dir).pump_at, Some(5));
        std::fs::write(cache_path(&dir), b"{}").unwrap();
        assert_eq!(load_cache(&dir).pump_at, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn retry_after_and_message() {
        assert_eq!(retry_after_secs(Some(" 3508 ")), Some(3508));
        assert_eq!(retry_after_secs(Some("soon")), None);
        assert_eq!(retry_after_secs(None), None);
        assert!(rate_limit_message(Some(3508), 3).contains("59 min"));
        assert!(rate_limit_message(Some(30), 1).contains("30 s"));
        assert!(rate_limit_message(None, 2).contains("2 wallet(s)"));
    }

    #[test]
    fn pump_vault_derivation_is_stable_and_distinct() {
        let creator = pk("2tSXsikwbcxJXimYKt5EbihcnTKaYjb1HeCvqoVuprME");
        let v = pump_creator_vault(&creator);
        let (auth, ata) = amm_vault_ata(&creator);
        assert_ne!(auth, ata);
        // Expected values come from Orquestra's `derive_pda` on the Pump and
        // Pump AMM IDLs (`collect_creator_fee`, `collect_coin_creator_fee`).
        assert_eq!(
            v.to_string(),
            "7hM1W2AH2gi46G8AcxeRd3ADWHwqZGrgkRZ7QUp4zMDY"
        );
        assert_eq!(
            auth.to_string(),
            "B9rXjVxSBadJE9ru4kBzAG6XoziN4dRvkNxBxjqV74XS"
        );
    }

    #[test]
    fn token_amount_reads_offset_64_and_requires_token_program() {
        let mut data = vec![0u8; 165];
        data[64..72].copy_from_slice(&42u64.to_le_bytes());
        let mut acc = Account {
            lamports: 1,
            data,
            owner: pk(TOKEN_PROGRAM_ID),
            executable: false,
            rent_epoch: 0,
        };
        assert_eq!(token_account_amount(&acc), 42);
        acc.owner = Pubkey::new_unique();
        assert_eq!(token_account_amount(&acc), 0);
    }
}
