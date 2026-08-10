//! One-click SOL consolidation.
//!
//! Every wallet is drained to zero: the amount sent is `balance - fee`, where
//! `fee` comes from `getFeeForMessage` for the exact message being signed, so
//! the transaction can never fail for being one lamport short. A wallet whose
//! balance does not cover its own fee is reported as skipped rather than
//! failing the run.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_sdk::hash::Hash;
use solana_sdk::instruction::Instruction;
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::transaction::Transaction;
use tokio::sync::Mutex as AsyncMutex;

use crate::error::{AppError, Result};
use crate::rpc;
use crate::state::SigningKey;

/// A plain SOL transfer needs far less than the 200k default. Requesting an
/// accurate limit keeps the priority fee (price x units) near zero.
const SWEEP_COMPUTE_UNITS: u32 = 1_000;

#[derive(Debug, Serialize)]
pub struct SweepPlanItem {
    pub pubkey: String,
    pub label: String,
    pub lamports: u64,
    pub fee: u64,
    pub net: u64,
    /// `None` means this wallet will be swept.
    pub skip_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SweepPlan {
    pub destination: String,
    pub items: Vec<SweepPlanItem>,
    pub total_net: u64,
    pub total_fees: u64,
    pub sweepable: usize,
    pub skipped: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct SweepProgress {
    pub pubkey: String,
    pub label: String,
    /// "sent" | "skipped" | "failed"
    pub status: String,
    pub lamports: u64,
    pub signature: Option<String>,
    pub error: Option<String>,
    pub done: usize,
    pub total: usize,
}

/// Blockhashes expire after roughly a minute. Sweeping 200 wallets takes
/// longer than that, so one is cached and refreshed on a timer instead of
/// being fetched once (stale) or per wallet (200 extra RPC calls).
struct BlockhashCache {
    rpc: Arc<RpcClient>,
    inner: AsyncMutex<Option<(Hash, Instant)>>,
    ttl: Duration,
}

impl BlockhashCache {
    fn new(rpc: Arc<RpcClient>) -> Self {
        Self {
            rpc,
            inner: AsyncMutex::new(None),
            ttl: Duration::from_secs(20),
        }
    }

    async fn get(&self) -> Result<Hash> {
        let mut guard = self.inner.lock().await;
        if let Some((hash, at)) = *guard {
            if at.elapsed() < self.ttl {
                return Ok(hash);
            }
        }
        let hash = self
            .rpc
            .get_latest_blockhash()
            .await
            .map_err(rpc::rpc_err)?;
        *guard = Some((hash, Instant::now()));
        Ok(hash)
    }
}

fn sweep_instructions(
    from: &Pubkey,
    to: &Pubkey,
    lamports: u64,
    priority_fee: u64,
) -> Vec<Instruction> {
    let mut ixs = vec![ComputeBudgetInstruction::set_compute_unit_limit(
        SWEEP_COMPUTE_UNITS,
    )];
    if priority_fee > 0 {
        ixs.push(ComputeBudgetInstruction::set_compute_unit_price(
            priority_fee,
        ));
    }
    ixs.push(solana_system_interface::instruction::transfer(
        from, to, lamports,
    ));
    ixs
}

/// Fee for the exact message shape that will be signed. The amount does not
/// affect the fee, so a zero-lamport placeholder gives the real number.
async fn fee_for(
    rpc: &RpcClient,
    from: &Pubkey,
    to: &Pubkey,
    priority_fee: u64,
    blockhash: Hash,
) -> Result<u64> {
    let ixs = sweep_instructions(from, to, 0, priority_fee);
    let mut message = Message::new(&ixs, Some(from));
    message.recent_blockhash = blockhash;
    rpc.get_fee_for_message(&message)
        .await
        .map_err(rpc::rpc_err)
}

/// What a single SOL transfer costs from `payer`. Every transfer this app
/// builds has the same message shape, so one quote prices any of them.
pub async fn transfer_fee(rpc: &RpcClient, payer: &Pubkey, priority_fee: u64) -> Result<u64> {
    let blockhash = rpc.get_latest_blockhash().await.map_err(rpc::rpc_err)?;
    fee_for(rpc, payer, payer, priority_fee, blockhash).await
}

#[derive(Debug, Serialize)]
pub struct SendQuote {
    pub from: String,
    pub destination: String,
    pub balance: u64,
    pub fee: u64,
    /// What the recipient receives.
    pub amount: u64,
    /// What stays behind after amount + fee.
    pub remaining: u64,
    pub max: bool,
}

#[derive(Debug, Serialize)]
pub struct SendResult {
    pub signature: String,
    pub amount: u64,
}

/// Price a single transfer. `lamports = None` means "send everything", which
/// drains the wallet to zero exactly as a sweep would.
pub async fn send_quote(
    rpc: Arc<RpcClient>,
    from_pubkey: &str,
    destination: &str,
    lamports: Option<u64>,
    priority_fee: u64,
) -> Result<SendQuote> {
    let from = rpc::parse_pubkey(from_pubkey)?;
    let dest = rpc::parse_pubkey(destination)?;
    if from == dest {
        return Err(AppError::invalid(
            "the destination is the same as the source wallet",
        ));
    }

    let balance = rpc.get_balance(&from).await.map_err(rpc::rpc_err)?;
    let blockhash = rpc.get_latest_blockhash().await.map_err(rpc::rpc_err)?;
    let fee = fee_for(&rpc, &from, &dest, priority_fee, blockhash).await?;

    let amount = match lamports {
        Some(requested) => requested,
        None => balance.saturating_sub(fee),
    };
    if amount == 0 {
        return Err(AppError::invalid("amount must be greater than zero"));
    }
    // The fee is paid by the sender on top of the transfer, so both have to fit
    // inside the balance.
    if amount + fee > balance {
        return Err(AppError::invalid(format!(
            "balance is {balance} lamports but sending {amount} needs {} with the fee",
            amount + fee
        )));
    }

    // An account that does not exist yet cannot be created below the
    // rent-exempt minimum: the runtime rejects the whole transaction with
    // "insufficient funds for rent". Catch it here, where the numbers can be
    // explained, rather than letting the RPC return that as a wall of logs.
    let destination_balance = rpc.get_balance(&dest).await.map_err(rpc::rpc_err)?;
    if destination_balance == 0 {
        let minimum = rpc
            .get_minimum_balance_for_rent_exemption(0)
            .await
            .map_err(rpc::rpc_err)?;
        if amount < minimum {
            return Err(AppError::invalid(format!(
                "{} has never been funded, so it must receive at least {} lamports \
                 ({:.9} SOL) to exist on chain - sending {amount} would be rejected for rent",
                dest,
                minimum,
                minimum as f64 / 1_000_000_000.0,
            )));
        }
    }

    Ok(SendQuote {
        from: from.to_string(),
        destination: dest.to_string(),
        balance,
        fee,
        amount,
        remaining: balance - amount - fee,
        max: lamports.is_none(),
    })
}

/// Sign and submit a single transfer. The quote is recomputed here so the
/// numbers are fresh at signing time rather than whatever the dialog last saw.
pub async fn send(
    rpc: Arc<RpcClient>,
    key: &SigningKey,
    destination: &str,
    lamports: Option<u64>,
    priority_fee: u64,
) -> Result<SendResult> {
    let quote = send_quote(
        rpc.clone(),
        &key.pubkey,
        destination,
        lamports,
        priority_fee,
    )
    .await?;

    let from = rpc::parse_pubkey(&quote.from)?;
    let dest = rpc::parse_pubkey(&quote.destination)?;
    let blockhash = rpc.get_latest_blockhash().await.map_err(rpc::rpc_err)?;

    let keypair = key.keypair()?;
    let ixs = sweep_instructions(&from, &dest, quote.amount, priority_fee);
    let mut tx = Transaction::new_unsigned(Message::new(&ixs, Some(&from)));
    tx.try_sign(&[&keypair], blockhash)
        .map_err(|e| AppError::invalid(format!("signing failed: {e}")))?;

    let sig = rpc
        .send_and_confirm_transaction(&tx)
        .await
        .map_err(rpc::rpc_err)?;

    Ok(SendResult {
        signature: sig.to_string(),
        amount: quote.amount,
    })
}

/// Build the sweep plan without signing anything. This is what the confirmation
/// dialog shows; nothing touches the network beyond reads.
pub async fn plan(
    rpc: Arc<RpcClient>,
    keys: &[SigningKey],
    destination: &str,
    priority_fee: u64,
    concurrency: usize,
) -> Result<SweepPlan> {
    let dest = rpc::parse_pubkey(destination)?;
    let pubkeys: Vec<Pubkey> = keys
        .iter()
        .map(|k| rpc::parse_pubkey(&k.pubkey))
        .collect::<Result<_>>()?;

    let balances = rpc::fetch_balances(rpc.clone(), &pubkeys, concurrency).await;
    let blockhash = rpc.get_latest_blockhash().await.map_err(rpc::rpc_err)?;

    // The fee is identical for every wallet (same message shape), so it is
    // priced once rather than 200 times.
    let sample = pubkeys.first().copied().unwrap_or(dest);
    let unit_fee = fee_for(&rpc, &sample, &dest, priority_fee, blockhash).await?;

    let mut items = Vec::with_capacity(keys.len());
    for key in keys {
        let pk = rpc::parse_pubkey(&key.pubkey)?;
        let lamports = balances
            .iter()
            .find(|(p, _)| *p == pk)
            .and_then(|(_, b)| *b)
            .unwrap_or(0);

        let (net, skip_reason) = if pk == dest {
            (0, Some("this is the destination wallet".to_string()))
        } else if lamports == 0 {
            (0, Some("empty".to_string()))
        } else if lamports <= unit_fee {
            (
                0,
                Some(format!(
                    "balance {} lamports does not cover the {} lamport fee",
                    lamports, unit_fee
                )),
            )
        } else {
            (lamports - unit_fee, None)
        };

        items.push(SweepPlanItem {
            pubkey: key.pubkey.clone(),
            label: key.label.clone(),
            lamports,
            fee: if skip_reason.is_none() { unit_fee } else { 0 },
            net,
            skip_reason,
        });
    }

    let sweepable = items.iter().filter(|i| i.skip_reason.is_none()).count();
    Ok(SweepPlan {
        destination: dest.to_string(),
        total_net: items.iter().map(|i| i.net).sum(),
        total_fees: items.iter().map(|i| i.fee).sum(),
        skipped: items.len() - sweepable,
        sweepable,
        items,
    })
}

/// Execute the sweep. `on_progress` is called once per wallet as it completes
/// so the UI can stream a live log instead of freezing for several minutes.
pub async fn run<F>(
    rpc: Arc<RpcClient>,
    keys: Vec<SigningKey>,
    destination: &str,
    priority_fee: u64,
    concurrency: usize,
    on_progress: F,
) -> Result<Vec<SweepProgress>>
where
    F: Fn(SweepProgress) + Send + Sync + 'static,
{
    let dest = rpc::parse_pubkey(destination)?;
    let blockhashes = Arc::new(BlockhashCache::new(rpc.clone()));
    let on_progress = Arc::new(on_progress);
    let total = keys.len();
    let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    let results = rpc::map_bounded(keys, concurrency, |key| {
        let rpc = rpc.clone();
        let blockhashes = blockhashes.clone();
        let on_progress = on_progress.clone();
        let done = done.clone();
        async move {
            let progress = sweep_one(&rpc, &blockhashes, &key, &dest, priority_fee).await;
            let n = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let progress = SweepProgress {
                done: n,
                total,
                ..progress
            };
            on_progress(progress.clone());
            progress
        }
    })
    .await;

    Ok(results)
}

async fn sweep_one(
    rpc: &RpcClient,
    blockhashes: &BlockhashCache,
    key: &SigningKey,
    dest: &Pubkey,
    priority_fee: u64,
) -> SweepProgress {
    let base = |status: &str, lamports: u64, signature: Option<String>, error: Option<String>| {
        SweepProgress {
            pubkey: key.pubkey.clone(),
            label: key.label.clone(),
            status: status.to_string(),
            lamports,
            signature,
            error,
            done: 0,
            total: 0,
        }
    };

    let from = match rpc::parse_pubkey(&key.pubkey) {
        Ok(pk) => pk,
        Err(e) => return base("failed", 0, None, Some(e.to_string())),
    };
    if &from == dest {
        return base(
            "skipped",
            0,
            None,
            Some("this is the destination wallet".into()),
        );
    }

    match sweep_one_inner(rpc, blockhashes, key, &from, dest, priority_fee).await {
        Ok(Some((lamports, sig))) => base("sent", lamports, Some(sig), None),
        Ok(None) => base("skipped", 0, None, Some("nothing to sweep".into())),
        Err(AppError::Invalid(msg)) => base("skipped", 0, None, Some(msg)),
        Err(e) => base("failed", 0, None, Some(e.to_string())),
    }
}

async fn sweep_one_inner(
    rpc: &RpcClient,
    blockhashes: &BlockhashCache,
    key: &SigningKey,
    from: &Pubkey,
    dest: &Pubkey,
    priority_fee: u64,
) -> Result<Option<(u64, String)>> {
    // Re-read the balance immediately before signing. Cleanup may have just
    // returned rent to this wallet, and the preview may be minutes old.
    let lamports = rpc.get_balance(from).await.map_err(rpc::rpc_err)?;
    if lamports == 0 {
        return Ok(None);
    }

    let blockhash = blockhashes.get().await?;
    let fee = fee_for(rpc, from, dest, priority_fee, blockhash).await?;
    if lamports <= fee {
        return Err(AppError::invalid(format!(
            "balance {lamports} lamports does not cover the {fee} lamport fee"
        )));
    }
    let amount = lamports - fee;

    let keypair = key.keypair()?;
    let ixs = sweep_instructions(from, dest, amount, priority_fee);
    let message = Message::new(&ixs, Some(from));
    let mut tx = Transaction::new_unsigned(message);
    tx.try_sign(&[&keypair], blockhash)
        .map_err(|e| AppError::invalid(format!("signing failed: {e}")))?;

    let sig = rpc
        .send_and_confirm_transaction(&tx)
        .await
        .map_err(rpc::rpc_err)?;
    Ok(Some((amount, sig.to_string())))
}
