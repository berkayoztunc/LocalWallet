//! Stake accounts: discovery, deactivation and withdrawal.
//!
//! The two instructions are built by hand rather than pulled from
//! `solana-stake-interface`. That crate requires `wincode 0.6` while this
//! project's dependency graph resolves on `wincode 0.5`, and mixing the two
//! breaks the build outright. The encoding is small and stable, so the same
//! approach `tokens::close_account_ix` already takes applies here: the
//! discriminants and account metas below were read off the published source of
//! `solana-stake-interface` 4.4.0 and are pinned by unit tests.

use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::Arc;

use serde::Serialize;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_config::{
    RpcAccountInfoConfig, RpcProgramAccountsConfig, UiAccountEncoding,
};
use solana_client::rpc_filter::{Memcmp, RpcFilterType};
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::transaction::Transaction;

use crate::error::{AppError, Result};
use crate::rpc;
use crate::state::SigningKey;

/// The Stake program.
const STAKE_PROGRAM_ID: &str = "Stake11111111111111111111111111111111111111";
const CLOCK_SYSVAR_ID: &str = "SysvarC1ock11111111111111111111111111111111";
const STAKE_HISTORY_SYSVAR_ID: &str = "SysvarStakeHistory1111111111111111111111111";
const RENT_SYSVAR_ID: &str = "SysvarRent111111111111111111111111111111111";
/// `DelegateStake` still lists the stake config account even though the
/// program no longer reads it. Omitting it fails the instruction.
const STAKE_CONFIG_ID: &str = "StakeConfig11111111111111111111111111111111";

/// `StakeInstruction` variant indices. Bincode encodes the enum tag as a
/// little-endian u32, so the instruction data is the tag followed by any
/// payload.
const IX_INITIALIZE: u32 = 0;
const IX_DELEGATE: u32 = 2;
const IX_WITHDRAW: u32 = 4;
const IX_DEACTIVATE: u32 = 5;

/// `StakeStateV2::size_of()`. Every stake account is exactly this large, so
/// its rent-exempt minimum is a single lookup.
const STAKE_ACCOUNT_LEN: u64 = 200;

/// Byte offsets into `StakeStateV2`:
/// tag(4) + rent_exempt_reserve(8) puts the staker at 12, and the withdrawer
/// 32 bytes after it. These are what the `memcmp` filters match on.
const STAKER_OFFSET: usize = 12;
const WITHDRAWER_OFFSET: usize = 44;

/// `deactivation_epoch` is set to this when the stake is not deactivating.
const NEVER: u64 = u64::MAX;

fn stake_program() -> Pubkey {
    Pubkey::from_str(STAKE_PROGRAM_ID).unwrap()
}

/// Where a stake account sits in the activation lifecycle. Derived purely from
/// the epochs on the account against the current one, so it needs no extra RPC
/// call and is exhaustively unit tested.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StakeStatus {
    /// Delegated this epoch; earning nothing yet.
    Activating,
    /// Fully warmed up and earning.
    Active,
    /// Deactivation requested; cooling down.
    Deactivating,
    /// Cooldown complete. This is the only state a full withdrawal succeeds in.
    Inactive,
}

impl StakeStatus {
    pub fn derive(activation_epoch: u64, deactivation_epoch: u64, current_epoch: u64) -> Self {
        // Deactivation is checked first: an account deactivated in the same
        // epoch it was created is cooling down, not warming up.
        if deactivation_epoch != NEVER {
            return if current_epoch > deactivation_epoch {
                StakeStatus::Inactive
            } else {
                StakeStatus::Deactivating
            };
        }
        if current_epoch > activation_epoch {
            StakeStatus::Active
        } else {
            StakeStatus::Activating
        }
    }

    /// A full withdrawal only lands once the stake has finished cooling down.
    pub fn can_withdraw(self) -> bool {
        matches!(self, StakeStatus::Inactive)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct StakeAccount {
    pub address: String,
    /// The vault wallet that controls this account.
    pub owner_pubkey: String,
    pub owner_label: String,
    /// Vote account this stake is delegated to, if it is delegated at all.
    pub vote_account: Option<String>,
    /// Total lamports in the account, including the rent-exempt reserve.
    pub lamports: u64,
    /// The delegated portion.
    pub delegated: u64,
    pub rent_exempt_reserve: u64,
    pub activation_epoch: u64,
    pub deactivation_epoch: Option<u64>,
    pub status: StakeStatus,
    /// Whether this vault holds the key each action needs. An action we cannot
    /// authorise is disabled in the UI rather than offered and failed on chain.
    pub can_deactivate: bool,
    pub can_withdraw: bool,
}

#[derive(Debug, Serialize)]
pub struct StakeScan {
    pub accounts: Vec<StakeAccount>,
    pub current_epoch: u64,
    pub total_staked: u64,
    /// Lamports sitting in accounts that have finished cooling down.
    pub total_withdrawable: u64,
    pub active_count: usize,
    /// Wallets whose scan failed, so a partial result is never mistaken for
    /// "you have no stake".
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StakeProgress {
    pub address: String,
    pub label: String,
    /// "deactivated" | "withdrawn" | "failed"
    pub status: String,
    pub lamports: u64,
    pub signature: Option<String>,
    pub error: Option<String>,
    pub done: usize,
    pub total: usize,
}

/* ---------------------------- instructions ----------------------------- */

fn stake_ix(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction {
        program_id: stake_program(),
        accounts,
        data,
    }
}

/// `Deactivate`: begins the cooldown. Signed by the *stake* authority.
pub(crate) fn deactivate_ix(stake: &Pubkey, stake_authority: &Pubkey) -> Instruction {
    stake_ix(
        IX_DEACTIVATE.to_le_bytes().to_vec(),
        vec![
            AccountMeta::new(*stake, false),
            AccountMeta::new_readonly(Pubkey::from_str(CLOCK_SYSVAR_ID).unwrap(), false),
            AccountMeta::new_readonly(*stake_authority, true),
        ],
    )
}

/// `Withdraw`: moves lamports out. Signed by the *withdraw* authority, which
/// may differ from the stake authority.
pub(crate) fn withdraw_ix(
    stake: &Pubkey,
    withdraw_authority: &Pubkey,
    destination: &Pubkey,
    lamports: u64,
) -> Instruction {
    let mut data = IX_WITHDRAW.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    stake_ix(
        data,
        vec![
            AccountMeta::new(*stake, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(Pubkey::from_str(CLOCK_SYSVAR_ID).unwrap(), false),
            AccountMeta::new_readonly(Pubkey::from_str(STAKE_HISTORY_SYSVAR_ID).unwrap(), false),
            AccountMeta::new_readonly(*withdraw_authority, true),
        ],
    )
}

/// `Initialize`: sets the stake and withdraw authorities on a freshly created
/// account. Both are the funding wallet, so no new key material ever exists —
/// the vault already holds everything needed to unwind the position later.
pub(crate) fn initialize_ix(stake: &Pubkey, authority: &Pubkey) -> Instruction {
    let mut data = IX_INITIALIZE.to_le_bytes().to_vec();
    // Authorized { staker, withdrawer }
    data.extend_from_slice(authority.as_ref());
    data.extend_from_slice(authority.as_ref());
    // Lockup { unix_timestamp: i64, epoch: u64, custodian: Pubkey }, all zero:
    // an unlocked stake, withdrawable as soon as it has cooled down.
    data.extend_from_slice(&0i64.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(Pubkey::default().as_ref());

    stake_ix(
        data,
        vec![
            AccountMeta::new(*stake, false),
            AccountMeta::new_readonly(Pubkey::from_str(RENT_SYSVAR_ID).unwrap(), false),
        ],
    )
}

/// `DelegateStake`: points an initialised stake account at a validator.
pub(crate) fn delegate_ix(stake: &Pubkey, authority: &Pubkey, vote: &Pubkey) -> Instruction {
    stake_ix(
        IX_DELEGATE.to_le_bytes().to_vec(),
        vec![
            AccountMeta::new(*stake, false),
            AccountMeta::new_readonly(*vote, false),
            AccountMeta::new_readonly(Pubkey::from_str(CLOCK_SYSVAR_ID).unwrap(), false),
            AccountMeta::new_readonly(Pubkey::from_str(STAKE_HISTORY_SYSVAR_ID).unwrap(), false),
            // Unused by the program, still required in the account list.
            AccountMeta::new_readonly(Pubkey::from_str(STAKE_CONFIG_ID).unwrap(), false),
            AccountMeta::new_readonly(*authority, true),
        ],
    )
}

/* ------------------------------ discovery ------------------------------ */

/// Stake accounts a wallet controls. Two queries are needed because the two
/// authorities live at different offsets and can differ: the staker authorises
/// deactivation, the withdrawer authorises withdrawal.
async fn scan_wallet(rpc: &RpcClient, owner: &Pubkey) -> Result<Vec<(String, serde_json::Value)>> {
    let mut found: BTreeMap<String, serde_json::Value> = BTreeMap::new();

    for offset in [STAKER_OFFSET, WITHDRAWER_OFFSET] {
        let config = RpcProgramAccountsConfig {
            filters: Some(vec![RpcFilterType::Memcmp(Memcmp::new_base58_encoded(
                offset,
                owner.as_ref(),
            ))]),
            account_config: RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::JsonParsed),
                commitment: None,
                data_slice: None,
                min_context_slot: None,
            },
            with_context: None,
            sort_results: None,
        };

        let accounts = rpc
            .get_program_ui_accounts_with_config(&stake_program(), config)
            .await
            .map_err(rpc::rpc_err)?;

        for (address, account) in accounts {
            if let Ok(value) = serde_json::to_value(&account.data) {
                // The parsed payload has no lamports field, so carry the
                // account's own balance alongside it.
                found.entry(address.to_string()).or_insert_with(|| {
                    let mut v = value;
                    v["lamports"] = account.lamports.into();
                    v
                });
            }
        }
    }

    Ok(found.into_iter().collect())
}

fn parse_account(
    address: String,
    data: &serde_json::Value,
    owner_pubkey: &str,
    owner_label: &str,
    current_epoch: u64,
) -> Option<StakeAccount> {
    let info = &data["parsed"]["info"];
    let meta = &info["meta"];
    let delegation = &info["stake"]["delegation"];

    // A stake account with no delegation is initialised but not staked. It is
    // still worth showing: it holds lamports the user can withdraw.
    let vote_account = delegation["voter"].as_str().map(str::to_string);
    let delegated = delegation["stake"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let activation_epoch = delegation["activationEpoch"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let deactivation_epoch = delegation["deactivationEpoch"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(NEVER);

    let rent_exempt_reserve = meta["rentExemptReserve"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let lamports = data["lamports"].as_u64().unwrap_or(0);

    let staker = meta["authorized"]["staker"].as_str().unwrap_or_default();
    let withdrawer = meta["authorized"]["withdrawer"]
        .as_str()
        .unwrap_or_default();

    let status = if vote_account.is_some() {
        StakeStatus::derive(activation_epoch, deactivation_epoch, current_epoch)
    } else {
        // Never delegated, so nothing to cool down.
        StakeStatus::Inactive
    };

    Some(StakeAccount {
        address,
        owner_pubkey: owner_pubkey.to_string(),
        owner_label: owner_label.to_string(),
        vote_account,
        lamports,
        delegated,
        rent_exempt_reserve,
        activation_epoch,
        deactivation_epoch: (deactivation_epoch != NEVER).then_some(deactivation_epoch),
        status,
        can_deactivate: staker == owner_pubkey && status != StakeStatus::Inactive,
        can_withdraw: withdrawer == owner_pubkey && status.can_withdraw(),
    })
}

/// Scan every wallet for stake accounts. Two RPC calls per wallet, so this is
/// an explicit action rather than something that runs on load.
pub async fn scan(
    rpc: Arc<RpcClient>,
    keys: &[SigningKey],
    concurrency: usize,
) -> Result<StakeScan> {
    let epoch = rpc.get_epoch_info().await.map_err(rpc::rpc_err)?.epoch;

    let inputs: Vec<(String, String)> = keys
        .iter()
        .map(|k| (k.pubkey.clone(), k.label.clone()))
        .collect();

    let per_wallet = rpc::map_bounded(inputs, concurrency, |(pubkey, label)| {
        let rpc = rpc.clone();
        async move {
            let owner = match rpc::parse_pubkey(&pubkey) {
                Ok(pk) => pk,
                Err(e) => return (pubkey, Err(e.to_string())),
            };
            match scan_wallet(&rpc, &owner).await {
                Ok(found) => {
                    let accounts = found
                        .into_iter()
                        .filter_map(|(address, data)| {
                            parse_account(address, &data, &pubkey, &label, epoch)
                        })
                        .collect::<Vec<_>>();
                    (pubkey, Ok(accounts))
                }
                Err(e) => (pubkey, Err(e.to_string())),
            }
        }
    })
    .await;

    let mut accounts = Vec::new();
    let mut errors = Vec::new();
    for (pubkey, result) in per_wallet {
        match result {
            Ok(found) => accounts.extend(found),
            Err(e) => errors.push(format!("{pubkey}: {e}")),
        }
    }

    // Largest positions first: those are the ones worth acting on.
    accounts.sort_by_key(|a| std::cmp::Reverse(a.lamports));

    Ok(StakeScan {
        current_epoch: epoch,
        total_staked: accounts.iter().map(|a| a.lamports).sum(),
        total_withdrawable: accounts
            .iter()
            .filter(|a| a.status.can_withdraw())
            .map(|a| a.lamports)
            .sum(),
        active_count: accounts
            .iter()
            .filter(|a| a.status == StakeStatus::Active)
            .count(),
        accounts,
        errors,
    })
}

/* ------------------------------- actions ------------------------------- */

async fn send(rpc: &RpcClient, key: &SigningKey, ix: Instruction) -> Result<String> {
    let owner = rpc::parse_pubkey(&key.pubkey)?;
    let keypair = key.keypair()?;
    let blockhash = rpc.get_latest_blockhash().await.map_err(rpc::rpc_err)?;
    let mut tx = Transaction::new_unsigned(Message::new(&[ix], Some(&owner)));
    tx.try_sign(&[&keypair], blockhash)
        .map_err(|e| AppError::invalid(format!("signing failed: {e}")))?;
    let sig = rpc
        .send_and_confirm_transaction(&tx)
        .await
        .map_err(rpc::rpc_err)?;
    Ok(sig.to_string())
}

/* ------------------------------- staking ------------------------------- */

#[derive(Debug, Serialize)]
pub struct StakeQuote {
    pub balance: u64,
    /// Rent-exempt reserve the new stake account must hold. Recoverable when
    /// the position is eventually withdrawn.
    pub rent: u64,
    pub fee: u64,
    /// The protocol's minimum delegation.
    pub minimum_delegation: u64,
    /// The largest amount this wallet can stake while remaining rent-exempt
    /// itself. Zero when the wallet cannot afford to stake at all.
    pub max_stakeable: u64,
}

/// What a wallet can stake right now, and what it costs. Read-only.
pub async fn quote(
    rpc: Arc<RpcClient>,
    owner_pubkey: &str,
    priority_fee: u64,
) -> Result<StakeQuote> {
    let owner = rpc::parse_pubkey(owner_pubkey)?;
    let balance = rpc.get_balance(&owner).await.map_err(rpc::rpc_err)?;
    let rent = rpc
        .get_minimum_balance_for_rent_exemption(STAKE_ACCOUNT_LEN as usize)
        .await
        .map_err(rpc::rpc_err)?;
    let minimum_delegation = rpc
        .get_stake_minimum_delegation()
        .await
        .map_err(rpc::rpc_err)?;
    let fee = crate::sweep::transfer_fee(&rpc, &owner, priority_fee).await?;
    // The funding wallet is a fee payer: it must still clear the rent-exempt
    // floor afterwards or the runtime rejects the whole transaction.
    let wallet_floor = rpc
        .get_minimum_balance_for_rent_exemption(0)
        .await
        .map_err(rpc::rpc_err)?;

    Ok(StakeQuote {
        balance,
        rent,
        fee,
        minimum_delegation,
        max_stakeable: balance.saturating_sub(rent + fee + wallet_floor),
    })
}

/// A seed unique enough to avoid colliding with this wallet's existing stake
/// accounts. Seeds are capped at 32 bytes, so this stays short.
fn stake_seed(now_secs: u64) -> String {
    format!("stake:{now_secs}")
}

/// Create a stake account and delegate it, in one transaction.
///
/// The account is derived from the wallet with a seed rather than a fresh
/// keypair. That matters here: a keypair would be new key material the vault
/// would have to store and protect, and losing it would strand the stake.
/// A seed-derived account needs only the wallet's signature and can always be
/// re-derived, so the vault's contents stay exactly as they were.
pub async fn create_and_delegate(
    rpc: Arc<RpcClient>,
    key: &SigningKey,
    vote_account: &str,
    lamports: u64,
    priority_fee: u64,
) -> Result<(String, String)> {
    let owner = rpc::parse_pubkey(&key.pubkey)?;
    let vote = rpc::parse_pubkey(vote_account)?;

    let quote = quote(rpc.clone(), &key.pubkey, priority_fee).await?;
    if lamports < quote.minimum_delegation {
        return Err(AppError::invalid(format!(
            "the minimum delegation is {} lamports ({:.9} SOL)",
            quote.minimum_delegation,
            quote.minimum_delegation as f64 / 1_000_000_000.0
        )));
    }
    if lamports > quote.max_stakeable {
        return Err(AppError::invalid(format!(
            "this wallet can stake at most {} lamports once the {} rent reserve, the fee and its \
             own rent-exempt minimum are covered",
            quote.max_stakeable, quote.rent
        )));
    }

    // Derive an address that is free. A collision only happens if the same
    // wallet staked in the same second, but stepping the seed is cheaper than
    // an opaque "account already in use" failure.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let mut seed = stake_seed(now);
    let mut stake_address = Pubkey::create_with_seed(&owner, &seed, &stake_program())
        .map_err(|e| AppError::invalid(format!("could not derive a stake address: {e}")))?;
    for bump in 1..8u64 {
        if rpc.get_balance(&stake_address).await.unwrap_or(0) == 0 {
            break;
        }
        seed = stake_seed(now + bump);
        stake_address = Pubkey::create_with_seed(&owner, &seed, &stake_program())
            .map_err(|e| AppError::invalid(format!("could not derive a stake address: {e}")))?;
    }

    let instructions = vec![
        solana_system_interface::instruction::create_account_with_seed(
            &owner,
            &stake_address,
            &owner,
            &seed,
            // The account holds the delegation plus its own rent reserve.
            lamports + quote.rent,
            STAKE_ACCOUNT_LEN,
            &stake_program(),
        ),
        initialize_ix(&stake_address, &owner),
        delegate_ix(&stake_address, &owner, &vote),
    ];

    let keypair = key.keypair()?;
    let blockhash = rpc.get_latest_blockhash().await.map_err(rpc::rpc_err)?;
    let mut tx = Transaction::new_unsigned(Message::new(&instructions, Some(&owner)));
    tx.try_sign(&[&keypair], blockhash)
        .map_err(|e| AppError::invalid(format!("signing failed: {e}")))?;

    let signature = rpc
        .send_and_confirm_transaction(&tx)
        .await
        .map_err(rpc::rpc_err)?;
    Ok((signature.to_string(), stake_address.to_string()))
}

/// Begin cooldown on one stake account.
pub async fn deactivate(rpc: Arc<RpcClient>, key: &SigningKey, stake: &str) -> Result<String> {
    let stake_pubkey = rpc::parse_pubkey(stake)?;
    let owner = rpc::parse_pubkey(&key.pubkey)?;
    send(&rpc, key, deactivate_ix(&stake_pubkey, &owner)).await
}

/// Withdraw the whole balance of a cooled-down stake account.
///
/// The status is re-checked against the chain first: the scan behind the UI may
/// be minutes old, and an early withdraw fails with an opaque runtime error
/// rather than something a user can act on.
pub async fn withdraw(
    rpc: Arc<RpcClient>,
    key: &SigningKey,
    stake: &str,
    destination: &str,
) -> Result<(String, u64)> {
    let stake_pubkey = rpc::parse_pubkey(stake)?;
    let owner = rpc::parse_pubkey(&key.pubkey)?;
    let destination_pubkey = rpc::parse_pubkey(destination)?;

    let epoch = rpc.get_epoch_info().await.map_err(rpc::rpc_err)?.epoch;
    let found = scan_wallet(&rpc, &owner).await?;
    let (_, data) = found
        .into_iter()
        .find(|(address, _)| address == stake)
        .ok_or_else(|| AppError::invalid("this wallet does not control that stake account"))?;

    let account = parse_account(stake.to_string(), &data, &key.pubkey, &key.label, epoch)
        .ok_or_else(|| AppError::invalid("could not read the stake account"))?;

    if !account.status.can_withdraw() {
        return Err(AppError::invalid(match account.deactivation_epoch {
            Some(epoch) => format!(
                "still cooling down - withdrawable once epoch {} ends",
                epoch
            ),
            None => "still active - deactivate it first, then withdraw after the cooldown".into(),
        }));
    }

    let lamports = account.lamports;
    let signature = send(
        &rpc,
        key,
        withdraw_ix(&stake_pubkey, &owner, &destination_pubkey, lamports),
    )
    .await?;
    Ok((signature, lamports))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deactivate_encoding_matches_the_stake_program() {
        let stake = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let ix = deactivate_ix(&stake, &authority);

        assert_eq!(ix.program_id, stake_program());
        // Bincode tags the enum with a little-endian u32 and Deactivate has no
        // payload, so the whole instruction is four bytes.
        assert_eq!(ix.data, vec![5, 0, 0, 0]);
        assert_eq!(ix.accounts.len(), 3);
        assert!(ix.accounts[0].is_writable, "stake account must be writable");
        assert!(!ix.accounts[1].is_writable, "clock sysvar is read-only");
        assert!(ix.accounts[2].is_signer, "stake authority must sign");
        assert!(!ix.accounts[2].is_writable);
    }

    #[test]
    fn withdraw_encoding_carries_the_amount() {
        let stake = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let destination = Pubkey::new_unique();
        let ix = withdraw_ix(&stake, &authority, &destination, 1_234_567);

        let mut expected = vec![4u8, 0, 0, 0];
        expected.extend_from_slice(&1_234_567u64.to_le_bytes());
        assert_eq!(ix.data, expected);

        assert_eq!(ix.accounts.len(), 5);
        assert!(ix.accounts[0].is_writable, "stake account must be writable");
        assert!(ix.accounts[1].is_writable, "recipient must be writable");
        assert_eq!(ix.accounts[1].pubkey, destination);
        assert!(ix.accounts[4].is_signer, "withdraw authority must sign");
    }

    #[test]
    fn initialize_sets_both_authorities_to_the_wallet() {
        let stake = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let ix = initialize_ix(&stake, &authority);

        // tag(4) + staker(32) + withdrawer(32) + lockup(8 + 8 + 32) = 116
        assert_eq!(ix.data.len(), 116);
        assert_eq!(&ix.data[0..4], &[0, 0, 0, 0]);
        // Both authorities are the funding wallet, so unwinding the position
        // later never needs a key the vault does not already hold.
        assert_eq!(&ix.data[4..36], authority.as_ref());
        assert_eq!(&ix.data[36..68], authority.as_ref());
        // A zero lockup: nothing blocks withdrawal once it has cooled down.
        assert!(ix.data[68..116].iter().all(|b| *b == 0));

        assert_eq!(ix.accounts.len(), 2);
        assert!(ix.accounts[0].is_writable);
    }

    #[test]
    fn delegate_keeps_the_legacy_config_account() {
        let stake = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let vote = Pubkey::new_unique();
        let ix = delegate_ix(&stake, &authority, &vote);

        assert_eq!(ix.data, vec![2, 0, 0, 0]);
        // Six accounts, not five: the stake config is unused by the program
        // but still required in the list, and dropping it fails the
        // instruction.
        assert_eq!(ix.accounts.len(), 6);
        assert_eq!(ix.accounts[1].pubkey, vote);
        assert_eq!(
            ix.accounts[4].pubkey,
            Pubkey::from_str(STAKE_CONFIG_ID).unwrap()
        );
        assert!(ix.accounts[5].is_signer, "stake authority must sign");
    }

    #[test]
    fn a_seed_derived_stake_address_needs_no_new_keypair() {
        // The address is a pure function of the wallet, seed and program, so
        // it can always be re-derived - no key material is created.
        let owner = Pubkey::new_unique();
        let seed = stake_seed(1_700_000_000);
        let a = Pubkey::create_with_seed(&owner, &seed, &stake_program()).unwrap();
        let b = Pubkey::create_with_seed(&owner, &seed, &stake_program()).unwrap();
        assert_eq!(a, b, "derivation must be deterministic");

        // Seeds are capped at 32 bytes.
        assert!(seed.len() <= 32, "seed too long: {}", seed.len());
        // A different second gives a different account.
        let other =
            Pubkey::create_with_seed(&owner, &stake_seed(1_700_000_001), &stake_program()).unwrap();
        assert_ne!(a, other);
    }

    #[test]
    fn status_walks_the_activation_lifecycle() {
        // Delegated this epoch: warming up, not yet earning.
        assert_eq!(StakeStatus::derive(10, NEVER, 10), StakeStatus::Activating);
        // A later epoch means it is fully active.
        assert_eq!(StakeStatus::derive(10, NEVER, 11), StakeStatus::Active);
        // Deactivation requested this epoch: still cooling down.
        assert_eq!(StakeStatus::derive(10, 12, 12), StakeStatus::Deactivating);
        // The epoch after deactivation completes it.
        assert_eq!(StakeStatus::derive(10, 12, 13), StakeStatus::Inactive);
    }

    #[test]
    fn deactivation_in_the_activation_epoch_is_cooling_down_not_warming_up() {
        // Created and deactivated in the same epoch. Checking activation first
        // would wrongly call this "activating" and offer a deactivate button
        // for something already deactivating.
        assert_eq!(StakeStatus::derive(10, 10, 10), StakeStatus::Deactivating);
        assert_eq!(StakeStatus::derive(10, 10, 11), StakeStatus::Inactive);
    }

    #[test]
    fn only_inactive_stake_can_be_withdrawn() {
        assert!(StakeStatus::Inactive.can_withdraw());
        assert!(!StakeStatus::Active.can_withdraw());
        assert!(!StakeStatus::Activating.can_withdraw());
        assert!(!StakeStatus::Deactivating.can_withdraw());
    }

    #[test]
    fn authority_offsets_match_the_stake_state_layout() {
        // tag(4) + rent_exempt_reserve(8) = staker at 12; withdrawer follows
        // one pubkey later.
        assert_eq!(STAKER_OFFSET, 4 + 8);
        assert_eq!(WITHDRAWER_OFFSET, STAKER_OFFSET + 32);
    }
}
