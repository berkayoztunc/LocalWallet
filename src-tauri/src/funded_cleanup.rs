//! Fund → close → return.
//!
//! A wallet drained to zero cannot pay the fee to close its own token
//! accounts, so the rent sitting in them is stranded. This flow lends each
//! wallet just enough SOL from a funding wallet, closes the accounts, then
//! drains the wallet to the configured sweep destination.
//!
//! The proceeds go to the destination rather than back to the funder, so the
//! funder does not recover its loan unless it *is* the destination. The plan
//! reports both sides of that so the UI can state it plainly.
//!
//! Every step is a real transaction and each stage waits for the previous one
//! to confirm: funding that has not landed cannot pay for a close, and a
//! return that runs early would take the fee money with it.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde::Serialize;
use solana_client::nonblocking::rpc_client::RpcClient;
use tokio::sync::Mutex as AsyncMutex;

use crate::error::{AppError, Result};
use crate::rpc;
use crate::state::SigningKey;
use crate::sweep;
use crate::tokens;

/// Head-room for close transactions beyond the batched estimate. If a batch
/// fails, cleanup retries that chunk one account at a time, which costs extra
/// transactions. Ten spare fees is a fraction of a cent and is swept onward
/// with everything else, so it is cheap insurance against a wallet stranding
/// itself halfway through.
const RETRY_MARGIN_TXS: u64 = 10;

#[derive(Debug, Serialize)]
pub struct FundedCleanupItem {
    pub pubkey: String,
    pub label: String,
    pub closable_accounts: usize,
    pub balance: u64,
    /// What the funder must send for this wallet to pay its own way.
    pub funding_needed: u64,
    /// Rent held by the accounts that will be closed.
    pub reclaimable: u64,
    /// Every fee this wallet's rescue will cost, funding transfer included.
    pub fees: u64,
    pub skip_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FundedCleanupPlan {
    pub funder: String,
    pub funder_label: String,
    pub funder_balance: u64,
    pub destination: String,
    /// True when funder and destination are the same wallet, in which case the
    /// loan comes straight back and the run is self-balancing.
    pub returns_to_funder: bool,
    pub items: Vec<FundedCleanupItem>,
    /// Total the funder sends out.
    pub total_funding: u64,
    /// Rent expected back across every eligible wallet.
    pub total_reclaimable: u64,
    pub total_fees: u64,
    /// What the destination should receive: the loans plus the rent, less fees.
    pub destination_receives: u64,
    pub eligible: usize,
    pub skipped: usize,
    /// True when the funder cannot cover the funding plus its own transfer fees.
    pub underfunded: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct FundedCleanupProgress {
    pub pubkey: String,
    pub label: String,
    /// "funding" | "closing" | "returning" | "done" | "skipped" | "failed"
    pub stage: String,
    pub funded_lamports: u64,
    pub accounts_closed: usize,
    pub reclaimed_lamports: u64,
    pub returned_lamports: u64,
    pub signatures: Vec<String>,
    pub error: Option<String>,
    pub done: usize,
    pub total: usize,
}

impl FundedCleanupProgress {
    fn new(key: &SigningKey, total: usize) -> Self {
        Self {
            pubkey: key.pubkey.clone(),
            label: key.label.clone(),
            stage: "funding".into(),
            funded_lamports: 0,
            accounts_closed: 0,
            reclaimed_lamports: 0,
            returned_lamports: 0,
            signatures: vec![],
            error: None,
            done: 0,
            total,
        }
    }

    fn fail(mut self, message: String) -> Self {
        self.stage = "failed".into();
        self.error = Some(message);
        self
    }

    fn skip(mut self, message: String) -> Self {
        self.stage = "skipped".into();
        self.error = Some(message);
        self
    }
}

/// Lamports this wallet needs on hand to close `accounts` and send the rest
/// onward afterwards.
///
/// The rent-exempt minimum and the fees are **added**, not compared. Two
/// separate rules bite here:
///
/// 1. An account may not hold a non-zero balance below the rent-exempt
///    minimum, so the wallet has to clear that floor to exist at all.
/// 2. The runtime validates the fee payer *before* instructions execute, using
///    only `balance - fee`. The rent a close is about to return does not count
///    yet. A wallet sitting at exactly the minimum therefore cannot pay for
///    any transaction: `balance - fee` drops it from RentExempt to RentPaying,
///    which is rejected as "insufficient funds for rent".
///
/// So the wallet needs the floor *plus* every fee it will spend. The whole
/// amount is swept onward at the end, so the larger loan costs nothing beyond
/// briefly tying up capital.
fn funding_for(accounts: usize, close_fee: u64, return_fee: u64, min_balance: u64) -> u64 {
    let close_txs = accounts.div_ceil(tokens::CLOSES_PER_TX) as u64;
    let for_fees = (close_txs + RETRY_MARGIN_TXS) * close_fee + return_fee;
    min_balance + for_fees
}

/// Every fee spent on one wallet's behalf: the funding transfer, the closes,
/// and the return transfer.
fn total_fees(accounts: usize, close_fee: u64, return_fee: u64, fund_fee: u64) -> u64 {
    let close_txs = accounts.div_ceil(tokens::CLOSES_PER_TX) as u64;
    close_txs * close_fee + return_fee + fund_fee
}

struct Costs {
    close_fee: u64,
    return_fee: u64,
    fund_fee: u64,
    /// Rent-exempt minimum for a 165-byte token account: what each close
    /// returns to the wallet.
    rent: u64,
    /// Rent-exempt minimum for a 0-byte system account: the smallest balance a
    /// plain wallet is allowed to hold.
    min_balance: u64,
}

async fn costs(rpc: &RpcClient, funder: &SigningKey, priority_fee: u64) -> Result<Costs> {
    let funder_pubkey = rpc::parse_pubkey(&funder.pubkey)?;
    // Funding and returning are both plain transfers, so one quote prices both.
    let transfer = sweep::transfer_fee(rpc, &funder_pubkey, priority_fee).await?;
    Ok(Costs {
        close_fee: tokens::close_tx_fee(rpc, &funder_pubkey).await?,
        return_fee: transfer,
        fund_fee: transfer,
        rent: tokens::rent_per_account(rpc).await,
        min_balance: rpc
            .get_minimum_balance_for_rent_exemption(0)
            .await
            .map_err(rpc::rpc_err)?,
    })
}

/// Work out which wallets are worth rescuing and what it will cost. Reads
/// only - nothing is signed here.
pub async fn plan(
    rpc: Arc<RpcClient>,
    funder: &SigningKey,
    targets: &[SigningKey],
    destination: &str,
    priority_fee: u64,
    concurrency: usize,
) -> Result<FundedCleanupPlan> {
    let destination = destination.trim();
    if destination.is_empty() {
        return Err(AppError::invalid(
            "set a sweep destination in Settings before running a funded cleanup",
        ));
    }
    let destination_key = rpc::parse_pubkey(destination)?;
    let funder_pubkey = rpc::parse_pubkey(&funder.pubkey)?;
    let costs = costs(&rpc, funder, priority_fee).await?;
    let funder_balance = rpc
        .get_balance(&funder_pubkey)
        .await
        .map_err(rpc::rpc_err)?;

    let inputs: Vec<(String, String)> = targets
        .iter()
        .filter(|k| k.pubkey != funder.pubkey)
        .map(|k| (k.pubkey.clone(), k.label.clone()))
        .collect();

    let close_fee = costs.close_fee;
    let return_fee = costs.return_fee;
    let fund_fee = costs.fund_fee;
    let rent = costs.rent;
    let min_balance = costs.min_balance;

    let items = rpc::map_bounded(inputs, concurrency, |(pubkey, label)| {
        let rpc = rpc.clone();
        async move {
            let mut item = FundedCleanupItem {
                pubkey: pubkey.clone(),
                label,
                closable_accounts: 0,
                balance: 0,
                funding_needed: 0,
                reclaimable: 0,
                fees: 0,
                skip_reason: None,
            };

            let owner = match rpc::parse_pubkey(&pubkey) {
                Ok(pk) => pk,
                Err(e) => {
                    item.skip_reason = Some(e.to_string());
                    return item;
                }
            };

            let accounts = match tokens::scan_closable(&rpc, &owner).await {
                Ok(a) => a,
                Err(e) => {
                    item.skip_reason = Some(e.to_string());
                    return item;
                }
            };
            item.closable_accounts = accounts.len();
            item.reclaimable = rent * accounts.len() as u64;
            item.balance = rpc.get_balance(&owner).await.unwrap_or(0);

            if accounts.is_empty() {
                item.skip_reason = Some("nothing closable".into());
                return item;
            }

            let required = funding_for(accounts.len(), close_fee, return_fee, min_balance);
            item.funding_needed = required.saturating_sub(item.balance);
            item.fees = total_fees(accounts.len(), close_fee, return_fee, fund_fee);

            // Refuse to spend more in fees than the rent is worth. Rent beats
            // fees by roughly 400x in practice, but a priority-fee spike on a
            // single-account wallet could invert that.
            if item.reclaimable <= item.fees {
                item.skip_reason = Some("fees would exceed the rent reclaimed".into());
            } else if item.funding_needed == 0 {
                item.skip_reason = Some("already funded - use the normal close".into());
            }
            item
        }
    })
    .await;

    let eligible: Vec<&FundedCleanupItem> =
        items.iter().filter(|i| i.skip_reason.is_none()).collect();
    let total_funding: u64 = eligible.iter().map(|i| i.funding_needed).sum();
    let total_reclaimable: u64 = eligible.iter().map(|i| i.reclaimable).sum();
    let total_fees: u64 = eligible.iter().map(|i| i.fees).sum();
    let eligible_count = eligible.len();

    Ok(FundedCleanupPlan {
        funder: funder.pubkey.clone(),
        funder_label: funder.label.clone(),
        funder_balance,
        destination: destination_key.to_string(),
        returns_to_funder: destination_key == funder_pubkey,
        // Each wallet forwards its loan plus the rent, less what it spends
        // getting there.
        destination_receives: (total_funding + total_reclaimable)
            .saturating_sub(total_fees - fund_fee * eligible_count as u64),
        total_funding,
        total_reclaimable,
        total_fees,
        // The funder pays fees as well, and must itself stay above the
        // rent-exempt floor or its own transfers get rejected.
        underfunded: funder_balance
            < total_funding + fund_fee * eligible_count as u64 + costs.min_balance,
        skipped: items.len() - eligible_count,
        eligible: eligible_count,
        items,
    })
}

/// Run the rescue. `on_progress` fires on every stage transition so the UI can
/// show which of the three steps each wallet is on.
pub async fn run<F>(
    rpc: Arc<RpcClient>,
    funder: SigningKey,
    targets: Vec<SigningKey>,
    destination: String,
    priority_fee: u64,
    concurrency: usize,
    on_progress: F,
) -> Result<Vec<FundedCleanupProgress>>
where
    F: Fn(FundedCleanupProgress) + Send + Sync + 'static,
{
    let destination = destination.trim().to_string();
    if destination.is_empty() {
        return Err(AppError::invalid(
            "set a sweep destination in Settings before running a funded cleanup",
        ));
    }
    rpc::parse_pubkey(&destination)?;

    let costs = costs(&rpc, &funder, priority_fee).await?;

    let targets: Vec<SigningKey> = targets
        .into_iter()
        .filter(|k| k.pubkey != funder.pubkey)
        .collect();
    let total = targets.len();

    let on_progress = Arc::new(on_progress);
    let done = Arc::new(AtomicUsize::new(0));
    // Every funding transfer leaves the same wallet. Serialising just that step
    // keeps concurrent sends from each sizing themselves against a balance the
    // others are about to spend.
    let funding_lock = Arc::new(AsyncMutex::new(()));
    let funder = Arc::new(funder);
    let destination = Arc::new(destination);
    let costs = Arc::new(costs);

    let results = rpc::map_bounded(targets, concurrency, |key| {
        let rpc = rpc.clone();
        let funder = funder.clone();
        let destination = destination.clone();
        let costs = costs.clone();
        let funding_lock = funding_lock.clone();
        let on_progress = on_progress.clone();
        let done = done.clone();
        async move {
            let progress = rescue_one(
                rpc,
                &funder,
                &key,
                &destination,
                &costs,
                priority_fee,
                &funding_lock,
                total,
                on_progress.as_ref(),
            )
            .await;

            let n = done.fetch_add(1, Ordering::SeqCst) + 1;
            let finished = FundedCleanupProgress {
                done: n,
                ..progress
            };
            on_progress(finished.clone());
            finished
        }
    })
    .await;

    Ok(results)
}

#[allow(clippy::too_many_arguments)]
async fn rescue_one(
    rpc: Arc<RpcClient>,
    funder: &SigningKey,
    key: &SigningKey,
    destination: &str,
    costs: &Costs,
    priority_fee: u64,
    funding_lock: &AsyncMutex<()>,
    total: usize,
    on_progress: &(dyn Fn(FundedCleanupProgress) + Send + Sync),
) -> FundedCleanupProgress {
    let mut progress = FundedCleanupProgress::new(key, total);

    let owner = match rpc::parse_pubkey(&key.pubkey) {
        Ok(pk) => pk,
        Err(e) => return progress.fail(e.to_string()),
    };

    // Re-check on chain rather than trusting the preview, which may be minutes
    // old and could have been built before someone else closed these accounts.
    let accounts = match tokens::scan_closable(&rpc, &owner).await {
        Ok(a) => a,
        Err(e) => return progress.fail(e.to_string()),
    };
    if accounts.is_empty() {
        return progress.skip("nothing closable".into());
    }

    let balance = rpc.get_balance(&owner).await.unwrap_or(0);
    let required = funding_for(
        accounts.len(),
        costs.close_fee,
        costs.return_fee,
        costs.min_balance,
    );
    let shortfall = required.saturating_sub(balance);

    // ---- Stage 1: fund ----
    if shortfall > 0 {
        on_progress(progress.clone());
        let funded = {
            let _guard = funding_lock.lock().await;
            sweep::send(
                rpc.clone(),
                funder,
                &key.pubkey,
                Some(shortfall),
                priority_fee,
            )
            .await
        };
        match funded {
            Ok(result) => {
                progress.funded_lamports = result.amount;
                progress.signatures.push(result.signature);
            }
            Err(e) => return progress.fail(format!("funding failed: {e}")),
        }
    }

    // ---- Stage 2: close ----
    progress.stage = "closing".into();
    on_progress(progress.clone());

    let cleanup = tokens::cleanup_one(&rpc, key, costs.rent).await;
    progress.accounts_closed = cleanup.accounts_closed;
    progress.reclaimed_lamports = cleanup.reclaimed_lamports;
    progress.signatures.extend(cleanup.signatures);

    if cleanup.accounts_closed == 0 {
        // The loan is sitting in a wallet that just failed; forward it rather
        // than leaving it stranded there.
        progress.stage = "returning".into();
        let returned = sweep::send(rpc.clone(), key, destination, None, priority_fee).await;
        apply_return(&mut progress, returned);
        return progress.fail(
            cleanup
                .error
                .unwrap_or_else(|| "no accounts were closed".into()),
        );
    }

    // ---- Stage 3: return ----
    progress.stage = "returning".into();
    on_progress(progress.clone());

    let returned = sweep::send(rpc, key, destination, None, priority_fee).await;
    let ok = returned.is_ok();
    apply_return(&mut progress, returned);

    if ok {
        progress.stage = "done".into();
        // Some accounts closed and some did not: worth reporting without
        // calling the whole wallet a failure.
        if let Some(err) = cleanup.error {
            progress.error = Some(err);
        }
    }
    progress
}

fn apply_return(progress: &mut FundedCleanupProgress, returned: Result<sweep::SendResult>) {
    match returned {
        Ok(result) => {
            progress.returned_lamports = result.amount;
            progress.signatures.push(result.signature);
        }
        Err(e) => {
            progress.stage = "failed".into();
            progress.error = Some(format!("return failed: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real values: the per-signature base fee and the rent-exempt minimum for
    /// a 165-byte token account.
    const FEE: u64 = 5_000;
    const RENT: u64 = 2_039_280;
    /// Rent-exempt minimum for a 0-byte system account.
    const MIN_BALANCE: u64 = 890_880;

    #[test]
    fn funding_clears_the_rent_floor_and_still_leaves_fee_money() {
        // The bug this guards: funding a wallet to exactly the rent-exempt
        // minimum leaves it unable to pay for anything, because the fee payer
        // is validated on `balance - fee` before the close returns any rent.
        let funded = funding_for(1, FEE, FEE, MIN_BALANCE);
        assert!(funded > MIN_BALANCE, "must exceed the bare floor");
        assert!(
            funded - FEE >= MIN_BALANCE,
            "after one fee the wallet must still be rent-exempt"
        );
    }

    #[test]
    fn funding_survives_paying_every_fee_it_budgets_for() {
        // Worst case: every close is retried individually and the return runs,
        // all before any rent lands. The wallet must stay above the floor
        // throughout, or one of those transactions is rejected.
        let accounts = tokens::CLOSES_PER_TX + 1;
        let funded = funding_for(accounts, FEE, FEE, MIN_BALANCE);
        let worst_case_fees = (2 + RETRY_MARGIN_TXS + 1) * FEE;
        assert!(funded - worst_case_fees >= MIN_BALANCE);
    }

    #[test]
    fn funding_scales_with_the_number_of_close_batches() {
        let one = funding_for(tokens::CLOSES_PER_TX, FEE, FEE, MIN_BALANCE);
        let two = funding_for(tokens::CLOSES_PER_TX + 1, FEE, FEE, MIN_BALANCE);
        assert_eq!(two - one, FEE, "one extra batch costs exactly one more fee");
    }

    #[test]
    fn a_single_account_still_returns_more_than_the_loan() {
        // The loan grew again, so re-check the case that matters: one account
        // must still release more rent than the wallet had to be lent.
        assert!(RENT > funding_for(1, FEE, FEE, MIN_BALANCE));
    }

    #[test]
    fn rescuing_a_single_account_is_comfortably_profitable() {
        let fees = total_fees(1, FEE, FEE, FEE);
        assert!(RENT > fees);
        assert!(fees < RENT / 100, "fees should be under 1% of the rent");
    }

    #[test]
    fn the_economics_guard_trips_when_fees_approach_rent() {
        // The guard exists for a fee spike: closing must never cost more than
        // the rent it releases.
        let silly = RENT;
        assert!(RENT <= total_fees(1, silly, silly, silly));
    }
}
