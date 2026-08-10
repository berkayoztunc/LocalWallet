//! Reclaiming rent from unused SPL token accounts.
//!
//! Only accounts with a zero balance are touched, and `CloseAccount` is built
//! and signed locally - there is no third-party service, no API key and no cut
//! taken from the reclaimed rent. Each closed account returns its rent
//! (~0.00203928 SOL) to the wallet that owns it.

use std::str::FromStr;
use std::sync::Arc;

use serde::Serialize;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_request::TokenAccountsFilter;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::transaction::Transaction;

use crate::error::{AppError, Result};
use crate::rpc;
use crate::state::SigningKey;

/// Legacy SPL Token program.
const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/// Token-2022. Its account layout shares the first 165 bytes with the legacy
/// program, so the same zero-balance check and close instruction apply.
const TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/// Closes are batched into one transaction each. 20 keeps the serialized
/// message comfortably under the 1232-byte transaction limit.
pub(crate) const CLOSES_PER_TX: usize = 20;

/// Placeholder for a balance the RPC response did not give us. Deliberately
/// not "0" so an unreadable account is never treated as empty.
const UNKNOWN_AMOUNT: &str = "unknown";

/// One token account as the chain reports it. `amount` is the raw integer
/// balance as a string, because a u64 of raw token units overflows the
/// precision of a JavaScript number; `ui_amount` is the human-readable value.
#[derive(Clone, Debug, Serialize)]
pub struct TokenAccount {
    pub address: String,
    pub mint: String,
    pub program: String,
    pub amount: String,
    pub decimals: u8,
    pub ui_amount: f64,
    pub frozen: bool,
    /// Set when the mint authority handed close rights to someone other than
    /// the account owner. Spam and airdrop tokens do this routinely.
    pub close_authority: Option<String>,
}

impl TokenAccount {
    pub fn is_empty(&self) -> bool {
        self.amount == "0"
    }

    /// `CloseAccount` validates the signer against
    /// `close_authority.unwrap_or(owner)`. When a different close authority is
    /// set, the owner's signature is rejected with `OwnerMismatch` (0x4), so
    /// those accounts are unclosable by us and must never be attempted.
    pub fn closable_by(&self, owner: &str) -> bool {
        self.is_empty()
            && !self.frozen
            && match &self.close_authority {
                None => true,
                Some(authority) => authority == owner,
            }
    }
}

/// Everything found for one wallet, with the counts the dashboard displays.
#[derive(Clone, Debug, Serialize)]
pub struct WalletTokens {
    pub pubkey: String,
    pub label: String,
    pub accounts: Vec<TokenAccount>,
    pub total_accounts: usize,
    pub empty_accounts: usize,
    pub with_balance: usize,
    pub frozen_accounts: usize,
    /// Empty accounts a different close authority has locked us out of.
    pub locked_accounts: usize,
    pub reclaimable_lamports: u64,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TokenScan {
    pub wallets: Vec<WalletTokens>,
    pub total_accounts: usize,
    pub total_empty: usize,
    pub total_with_balance: usize,
    pub total_reclaimable_lamports: u64,
}

#[derive(Debug, Serialize)]
pub struct CleanupPreviewItem {
    pub pubkey: String,
    pub label: String,
    pub accounts: Vec<TokenAccount>,
    pub reclaimable_lamports: u64,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CleanupPreview {
    pub items: Vec<CleanupPreviewItem>,
    pub total_accounts: usize,
    pub total_reclaimable_lamports: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct CleanupProgress {
    pub pubkey: String,
    pub label: String,
    /// "closed" | "skipped" | "failed"
    pub status: String,
    pub accounts_closed: usize,
    pub reclaimed_lamports: u64,
    pub signatures: Vec<String>,
    pub error: Option<String>,
    pub done: usize,
    pub total: usize,
}

fn token_programs() -> Vec<(String, Pubkey)> {
    vec![
        (
            "spl-token".to_string(),
            Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap(),
        ),
        (
            "spl-token-2022".to_string(),
            Pubkey::from_str(TOKEN_2022_PROGRAM_ID).unwrap(),
        ),
    ]
}

/// Every token account owned by `owner`, across both token programs, with its
/// balance. Two RPC calls per wallet - the `getTokenAccountsByOwner` filter
/// takes one program id at a time.
pub async fn scan_all(rpc: &RpcClient, owner: &Pubkey) -> Result<Vec<TokenAccount>> {
    let mut found = Vec::new();
    for (program_name, program_id) in token_programs() {
        let accounts = rpc
            .get_token_accounts_by_owner(owner, TokenAccountsFilter::ProgramId(program_id))
            .await
            .map_err(rpc::rpc_err)?;

        for keyed in accounts {
            let data = match serde_json::to_value(&keyed.account.data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let info = &data["parsed"]["info"];
            let token_amount = &info["tokenAmount"];
            found.push(TokenAccount {
                address: keyed.pubkey.clone(),
                mint: info["mint"].as_str().unwrap_or_default().to_string(),
                program: program_name.clone(),
                // Fail safe: an amount we could not read must never look like
                // zero, or an account holding tokens would be offered up for
                // closing. `UNKNOWN_AMOUNT` is not "0", so it is not closable.
                amount: token_amount["amount"]
                    .as_str()
                    .unwrap_or(UNKNOWN_AMOUNT)
                    .to_string(),
                decimals: token_amount["decimals"].as_u64().unwrap_or(0) as u8,
                ui_amount: token_amount["uiAmount"].as_f64().unwrap_or(0.0),
                frozen: info["state"].as_str() == Some("frozen"),
                close_authority: info["closeAuthority"].as_str().map(str::to_string),
            });
        }
    }
    Ok(found)
}

/// The subset the cleanup flow acts on.
pub async fn scan_closable(rpc: &RpcClient, owner: &Pubkey) -> Result<Vec<TokenAccount>> {
    let owner_str = owner.to_string();
    Ok(scan_all(rpc, owner)
        .await?
        .into_iter()
        .filter(|a| a.closable_by(&owner_str))
        .collect())
}

/// Full token inventory across wallets: how many accounts each holds, which
/// hold a balance, and how much rent the empty ones are sitting on.
pub async fn scan(
    rpc: Arc<RpcClient>,
    keys: &[SigningKey],
    concurrency: usize,
) -> Result<TokenScan> {
    let rent = rent_per_account(&rpc).await;
    let inputs: Vec<(String, String)> = keys
        .iter()
        .map(|k| (k.pubkey.clone(), k.label.clone()))
        .collect();

    let wallets = rpc::map_bounded(inputs, concurrency, |(pubkey, label)| {
        let rpc = rpc.clone();
        async move {
            let empty = |error: Option<String>| WalletTokens {
                pubkey: pubkey.clone(),
                label: label.clone(),
                accounts: vec![],
                total_accounts: 0,
                empty_accounts: 0,
                with_balance: 0,
                frozen_accounts: 0,
                locked_accounts: 0,
                reclaimable_lamports: 0,
                error,
            };

            let owner = match rpc::parse_pubkey(&pubkey) {
                Ok(pk) => pk,
                Err(e) => return empty(Some(e.to_string())),
            };
            let accounts = match scan_all(&rpc, &owner).await {
                Ok(a) => a,
                Err(e) => return empty(Some(e.to_string())),
            };

            let closable = accounts.iter().filter(|a| a.closable_by(&pubkey)).count();
            WalletTokens {
                total_accounts: accounts.len(),
                empty_accounts: accounts.iter().filter(|a| a.is_empty()).count(),
                with_balance: accounts.iter().filter(|a| !a.is_empty()).count(),
                frozen_accounts: accounts.iter().filter(|a| a.frozen).count(),
                locked_accounts: accounts
                    .iter()
                    .filter(|a| {
                        a.is_empty() && a.close_authority.as_deref().is_some_and(|x| x != pubkey)
                    })
                    .count(),
                reclaimable_lamports: rent * closable as u64,
                accounts,
                ..empty(None)
            }
        }
    })
    .await;

    Ok(TokenScan {
        total_accounts: wallets.iter().map(|w| w.total_accounts).sum(),
        total_empty: wallets.iter().map(|w| w.empty_accounts).sum(),
        total_with_balance: wallets.iter().map(|w| w.with_balance).sum(),
        total_reclaimable_lamports: wallets.iter().map(|w| w.reclaimable_lamports).sum(),
        wallets,
    })
}

/// Rent held by a token account, read from the chain rather than hardcoded so
/// the number stays right if the rent rate ever changes.
pub async fn rent_per_account(rpc: &RpcClient) -> u64 {
    rpc.get_minimum_balance_for_rent_exemption(165)
        .await
        .unwrap_or(2_039_280)
}

pub async fn preview(
    rpc: Arc<RpcClient>,
    keys: &[SigningKey],
    concurrency: usize,
) -> Result<CleanupPreview> {
    let rent = rent_per_account(&rpc).await;
    let inputs: Vec<(String, String)> = keys
        .iter()
        .map(|k| (k.pubkey.clone(), k.label.clone()))
        .collect();

    let items = rpc::map_bounded(inputs, concurrency, |(pubkey, label)| {
        let rpc = rpc.clone();
        async move {
            let owner = match rpc::parse_pubkey(&pubkey) {
                Ok(pk) => pk,
                Err(e) => {
                    return CleanupPreviewItem {
                        pubkey,
                        label,
                        accounts: vec![],
                        reclaimable_lamports: 0,
                        error: Some(e.to_string()),
                    }
                }
            };
            match scan_closable(&rpc, &owner).await {
                Ok(accounts) => CleanupPreviewItem {
                    reclaimable_lamports: rent * accounts.len() as u64,
                    accounts,
                    pubkey,
                    label,
                    error: None,
                },
                Err(e) => CleanupPreviewItem {
                    pubkey,
                    label,
                    accounts: vec![],
                    reclaimable_lamports: 0,
                    error: Some(e.to_string()),
                },
            }
        }
    })
    .await;

    Ok(CleanupPreview {
        total_accounts: items.iter().map(|i| i.accounts.len()).sum(),
        total_reclaimable_lamports: items.iter().map(|i| i.reclaimable_lamports).sum(),
        items,
    })
}

pub async fn run<F>(
    rpc: Arc<RpcClient>,
    keys: Vec<SigningKey>,
    concurrency: usize,
    on_progress: F,
) -> Result<Vec<CleanupProgress>>
where
    F: Fn(CleanupProgress) + Send + Sync + 'static,
{
    let rent = rent_per_account(&rpc).await;
    let on_progress = Arc::new(on_progress);
    let total = keys.len();
    let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    let results = rpc::map_bounded(keys, concurrency, |key| {
        let rpc = rpc.clone();
        let on_progress = on_progress.clone();
        let done = done.clone();
        async move {
            let progress = cleanup_one(&rpc, &key, rent).await;
            let n = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let progress = CleanupProgress {
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

/// Close every closable token account for one wallet. Shared with the funded
/// cleanup flow, which runs this between a funding and a return transfer.
pub(crate) async fn cleanup_one(rpc: &RpcClient, key: &SigningKey, rent: u64) -> CleanupProgress {
    let mut progress = CleanupProgress {
        pubkey: key.pubkey.clone(),
        label: key.label.clone(),
        status: "skipped".into(),
        accounts_closed: 0,
        reclaimed_lamports: 0,
        signatures: vec![],
        error: None,
        done: 0,
        total: 0,
    };

    let owner = match rpc::parse_pubkey(&key.pubkey) {
        Ok(pk) => pk,
        Err(e) => {
            progress.status = "failed".into();
            progress.error = Some(e.to_string());
            return progress;
        }
    };

    let accounts = match scan_closable(rpc, &owner).await {
        Ok(a) => a,
        Err(e) => {
            progress.status = "failed".into();
            progress.error = Some(e.to_string());
            return progress;
        }
    };
    if accounts.is_empty() {
        progress.error = Some("no empty token accounts".into());
        return progress;
    }

    // Authoritative balance check against the chain. Anything holding tokens is
    // dropped here rather than sent into a transaction that would either fail
    // or, worse, destroy a balance.
    let (accounts, mut errors) = match verify_closable(rpc, &owner, &accounts).await {
        Ok((safe, rejected)) => (safe, rejected),
        Err(e) => {
            progress.status = "failed".into();
            progress.error = Some(e.to_string());
            return progress;
        }
    };
    if accounts.is_empty() {
        progress.error = Some(if errors.is_empty() {
            "no empty token accounts".into()
        } else {
            format!("nothing safe to close - {}", errors.join("; "))
        });
        return progress;
    }

    // Closing is itself a transaction, and the runtime validates the fee payer
    // on `balance - fee` *before* any instruction runs - the rent a close is
    // about to return does not count yet. So the wallet needs the rent-exempt
    // minimum plus a fee on top, not merely a non-zero balance. Checking it
    // here turns an opaque "insufficient funds for rent" into instructions.
    let balance = match rpc.get_balance(&owner).await {
        Ok(b) => b,
        Err(e) => {
            progress.status = "failed".into();
            progress.error = Some(rpc::rpc_err(e).to_string());
            return progress;
        }
    };
    let min_balance = rpc
        .get_minimum_balance_for_rent_exemption(0)
        .await
        .unwrap_or(890_880);
    let fee = close_tx_fee(rpc, &owner).await.unwrap_or(5_000);
    if balance < min_balance + fee {
        progress.status = "failed".into();
        progress.error = Some(format!(
            "wallet holds {balance} lamports but needs at least {} to pay a fee and stay \
             rent-exempt - use Fund & close instead",
            min_balance + fee
        ));
        return progress;
    }

    let keypair = match key.keypair() {
        Ok(kp) => kp,
        Err(e) => {
            progress.status = "failed".into();
            progress.error = Some(e.to_string());
            return progress;
        }
    };

    for chunk in accounts.chunks(CLOSES_PER_TX) {
        match close_batch(rpc, &keypair, &owner, chunk).await {
            Ok(sig) => {
                progress.signatures.push(sig);
                progress.accounts_closed += chunk.len();
            }
            Err(batch_err) => {
                // A single unclosable account (an exotic Token-2022 extension,
                // a delegate, a race with another wallet) must not cost the
                // whole batch, so the chunk is retried one account at a time.
                if chunk.len() == 1 {
                    errors.push(format!("{}: {}", chunk[0].address, batch_err));
                    continue;
                }
                for account in chunk {
                    match close_batch(rpc, &keypair, &owner, std::slice::from_ref(account)).await {
                        Ok(sig) => {
                            progress.signatures.push(sig);
                            progress.accounts_closed += 1;
                        }
                        Err(e) => errors.push(format!("{}: {}", account.address, e)),
                    }
                }
            }
        }
    }

    progress.reclaimed_lamports = rent * progress.accounts_closed as u64;
    progress.status = if progress.accounts_closed > 0 {
        "closed".into()
    } else {
        "failed".into()
    };
    if !errors.is_empty() {
        progress.error = Some(errors.join("; "));
    }
    progress
}

/// `CloseAccount` discriminator in the SPL Token instruction encoding.
const CLOSE_ACCOUNT_IX: u8 = 9;

/// Byte offsets into the 165-byte token account layout, shared by SPL Token
/// and Token-2022:
/// mint(32) owner(32) amount(8) delegate(36) state(1) is_native(12)
/// delegated_amount(8) close_authority(36).
const ACCOUNT_LEN: usize = 165;
const AMOUNT_OFFSET: usize = 64;
const OWNER_OFFSET: usize = 32;
const STATE_OFFSET: usize = 108;
const CLOSE_AUTHORITY_OFFSET: usize = 129;
const STATE_FROZEN: u8 = 2;

/// Decode the `COption<Pubkey>` close authority. The tag is a 4-byte
/// little-endian discriminant; 1 means `Some`.
fn close_authority_of(data: &[u8]) -> Option<Pubkey> {
    let tag = u32::from_le_bytes(
        data[CLOSE_AUTHORITY_OFFSET..CLOSE_AUTHORITY_OFFSET + 4]
            .try_into()
            .ok()?,
    );
    if tag != 1 {
        return None;
    }
    let key: [u8; 32] = data[CLOSE_AUTHORITY_OFFSET + 4..ACCOUNT_LEN]
        .try_into()
        .ok()?;
    Some(Pubkey::from(key))
}

/// Build `CloseAccount` by hand rather than via `spl_token::instruction`.
/// That helper calls `check_program_account`, which rejects any program id
/// other than the legacy SPL Token program - so every Token-2022 close failed
/// at build time with `IncorrectProgramId` and never reached the network.
/// The instruction encoding is identical for both programs.
fn close_account_ix(
    program_id: &Pubkey,
    account: &Pubkey,
    destination: &Pubkey,
    owner: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*owner, true),
        ],
        data: vec![CLOSE_ACCOUNT_IX],
    }
}

fn program_id_for(account: &TokenAccount) -> Pubkey {
    Pubkey::from_str(if account.program == "spl-token-2022" {
        TOKEN_2022_PROGRAM_ID
    } else {
        TOKEN_PROGRAM_ID
    })
    .unwrap()
}

/// Re-read the accounts straight from the chain and keep only the ones that
/// are provably safe to close. The scan that produced this list may be minutes
/// old, and closing an account that has since received tokens would burn them,
/// so the raw on-chain balance is the authority - not the earlier JSON parse.
async fn verify_closable(
    rpc: &RpcClient,
    owner: &Pubkey,
    accounts: &[TokenAccount],
) -> Result<(Vec<TokenAccount>, Vec<String>)> {
    let addresses: Vec<Pubkey> = accounts
        .iter()
        .map(|a| rpc::parse_pubkey(&a.address))
        .collect::<Result<_>>()?;

    let fetched = rpc
        .get_multiple_accounts(&addresses)
        .await
        .map_err(rpc::rpc_err)?;

    let mut safe = Vec::with_capacity(accounts.len());
    let mut rejected = Vec::new();

    for (account, fetched) in accounts.iter().zip(fetched) {
        let Some(raw) = fetched else {
            rejected.push(format!("{}: already closed", account.address));
            continue;
        };
        if raw.data.len() < ACCOUNT_LEN {
            rejected.push(format!("{}: not a token account", account.address));
            continue;
        }
        let amount = u64::from_le_bytes(
            raw.data[AMOUNT_OFFSET..AMOUNT_OFFSET + 8]
                .try_into()
                .expect("8 bytes"),
        );
        if amount != 0 {
            rejected.push(format!("{}: holds {amount} tokens", account.address));
            continue;
        }
        if raw.data[STATE_OFFSET] == STATE_FROZEN {
            rejected.push(format!("{}: frozen", account.address));
            continue;
        }
        // The owner field must be us, or our signature is not the one the
        // program checks.
        let account_owner: [u8; 32] = raw.data[OWNER_OFFSET..OWNER_OFFSET + 32]
            .try_into()
            .expect("32 bytes");
        if &Pubkey::from(account_owner) != owner {
            rejected.push(format!("{}: owned by another wallet", account.address));
            continue;
        }
        // CloseAccount validates against close_authority.unwrap_or(owner). A
        // third-party close authority means the owner's signature is rejected
        // with OwnerMismatch, so this can never succeed for us.
        if let Some(authority) = close_authority_of(&raw.data) {
            if &authority != owner {
                rejected.push(format!(
                    "{}: close authority is {authority}, not this wallet",
                    account.address
                ));
                continue;
            }
        }
        safe.push(account.clone());
    }
    Ok((safe, rejected))
}

/// Price a single close transaction. The base fee is per signature and a close
/// carries exactly one, so batch size does not change it - but it is queried
/// rather than assumed so a fee schedule change cannot strand a wallet.
pub(crate) async fn close_tx_fee(rpc: &RpcClient, owner: &Pubkey) -> Result<u64> {
    let program_id = Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap();
    let ix = close_account_ix(&program_id, owner, owner, owner);
    let blockhash = rpc.get_latest_blockhash().await.map_err(rpc::rpc_err)?;
    let mut message = Message::new(&[ix], Some(owner));
    message.recent_blockhash = blockhash;
    rpc.get_fee_for_message(&message)
        .await
        .map_err(rpc::rpc_err)
}

async fn close_batch(
    rpc: &RpcClient,
    keypair: &solana_sdk::signer::keypair::Keypair,
    owner: &Pubkey,
    accounts: &[TokenAccount],
) -> Result<String> {
    let mut ixs: Vec<Instruction> = Vec::with_capacity(accounts.len());
    for account in accounts {
        let address = rpc::parse_pubkey(&account.address)?;
        // Rent goes back to the wallet that owns the account; consolidating it
        // is the sweep's job, which runs afterwards.
        ixs.push(close_account_ix(
            &program_id_for(account),
            &address,
            owner,
            owner,
        ));
    }

    let blockhash = rpc.get_latest_blockhash().await.map_err(rpc::rpc_err)?;
    let message = Message::new(&ixs, Some(owner));
    let mut tx = Transaction::new_unsigned(message);
    tx.try_sign(&[keypair], blockhash)
        .map_err(|e| AppError::invalid(format!("signing failed: {e}")))?;

    let sig = rpc
        .send_and_confirm_transaction(&tx)
        .await
        .map_err(rpc::rpc_err)?;
    Ok(sig.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_ids_are_valid() {
        assert_eq!(
            Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap(),
            spl_token::id(),
            "legacy token program id must match the spl-token crate"
        );
        assert!(Pubkey::from_str(TOKEN_2022_PROGRAM_ID).is_ok());
    }

    const OWNER: &str = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

    fn account(amount: &str, frozen: bool) -> TokenAccount {
        TokenAccount {
            address: "addr".into(),
            mint: "mint".into(),
            program: "spl-token".into(),
            amount: amount.into(),
            decimals: 6,
            ui_amount: 0.0,
            frozen,
            close_authority: None,
        }
    }

    #[test]
    fn only_empty_unfrozen_accounts_are_closable() {
        assert!(account("0", false).closable_by(OWNER));
        // Frozen accounts are empty but are not offered up for closing.
        assert!(account("0", true).is_empty());
        assert!(!account("0", true).closable_by(OWNER));
        // Dust still counts as a balance.
        assert!(!account("1", false).is_empty());
        assert!(!account("1", false).closable_by(OWNER));
    }

    #[test]
    fn a_third_party_close_authority_makes_an_account_unclosable() {
        // CloseAccount validates against close_authority.unwrap_or(owner), so
        // signing as the owner here yields OwnerMismatch (0x4) on chain. These
        // must be filtered out rather than attempted.
        let mut locked = account("0", false);
        locked.close_authority = Some("SomeOtherAuthority11111111111111111111111111".into());
        assert!(locked.is_empty());
        assert!(!locked.closable_by(OWNER));

        // A close authority that is the owner is the same as none.
        let mut self_authority = account("0", false);
        self_authority.close_authority = Some(OWNER.into());
        assert!(self_authority.closable_by(OWNER));
    }

    #[test]
    fn decodes_the_close_authority_option_from_raw_account_data() {
        let mut data = vec![0u8; ACCOUNT_LEN];
        // Tag 0 is None, whatever follows it.
        data[CLOSE_AUTHORITY_OFFSET..CLOSE_AUTHORITY_OFFSET + 4]
            .copy_from_slice(&0u32.to_le_bytes());
        data[CLOSE_AUTHORITY_OFFSET + 4..ACCOUNT_LEN].copy_from_slice(&[7u8; 32]);
        assert_eq!(close_authority_of(&data), None);

        // Tag 1 is Some(pubkey).
        let authority = Pubkey::new_unique();
        data[CLOSE_AUTHORITY_OFFSET..CLOSE_AUTHORITY_OFFSET + 4]
            .copy_from_slice(&1u32.to_le_bytes());
        data[CLOSE_AUTHORITY_OFFSET + 4..ACCOUNT_LEN].copy_from_slice(authority.as_ref());
        assert_eq!(close_authority_of(&data), Some(authority));
    }

    #[test]
    fn raw_layout_offsets_match_a_packed_spl_token_account() {
        // Pack a real account through the spl-token crate and confirm every
        // offset this module reads by hand lands on the right field.
        use solana_sdk::program_pack::Pack;
        use spl_token::state::{Account as SplAccount, AccountState};

        let owner = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let account = SplAccount {
            mint: Pubkey::new_unique(),
            owner,
            amount: 12_345,
            delegate: None.into(),
            state: AccountState::Frozen,
            is_native: None.into(),
            delegated_amount: 0,
            close_authority: Some(authority).into(),
        };
        let mut data = vec![0u8; SplAccount::LEN];
        account.pack_into_slice(&mut data);

        assert_eq!(
            u64::from_le_bytes(data[AMOUNT_OFFSET..AMOUNT_OFFSET + 8].try_into().unwrap()),
            12_345
        );
        assert_eq!(
            Pubkey::try_from(&data[OWNER_OFFSET..OWNER_OFFSET + 32]).unwrap(),
            owner
        );
        assert_eq!(data[STATE_OFFSET], STATE_FROZEN);
        assert_eq!(close_authority_of(&data), Some(authority));
    }

    #[test]
    fn an_unreadable_balance_is_never_closable() {
        // The RPC gave us no amount. Treating that as zero would offer a
        // funded account up for closing, so it must count as non-empty.
        let unknown = account(UNKNOWN_AMOUNT, false);
        assert!(!unknown.is_empty());
        assert!(!unknown.closable_by(OWNER));
    }

    #[test]
    fn close_instruction_builds_for_both_token_programs() {
        let account_pk = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        for program_id in [
            Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap(),
            Pubkey::from_str(TOKEN_2022_PROGRAM_ID).unwrap(),
        ] {
            let ix = close_account_ix(&program_id, &account_pk, &owner, &owner);
            assert_eq!(ix.program_id, program_id);
            assert_eq!(ix.data, vec![CLOSE_ACCOUNT_IX]);
            assert_eq!(ix.accounts.len(), 3);
            assert!(ix.accounts[0].is_writable, "token account must be writable");
            assert!(
                ix.accounts[1].is_writable,
                "rent destination must be writable"
            );
            assert!(ix.accounts[2].is_signer, "owner must sign");
        }
    }

    #[test]
    fn hand_built_close_matches_the_spl_token_encoding() {
        // The legacy path is the reference: our hand-rolled instruction must be
        // byte-identical to what the spl-token crate produces. (That helper
        // cannot be used directly because it rejects the Token-2022 program id.)
        let program_id = Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap();
        let account_pk = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        let reference =
            spl_token::instruction::close_account(&program_id, &account_pk, &owner, &owner, &[])
                .unwrap();
        let ours = close_account_ix(&program_id, &account_pk, &owner, &owner);

        assert_eq!(ours.program_id, reference.program_id);
        assert_eq!(ours.data, reference.data);
        assert_eq!(ours.accounts, reference.accounts);
    }

    #[test]
    fn spl_token_helper_rejects_token_2022_which_is_why_we_hand_build() {
        // Guards the reason this code exists: if a future spl-token release
        // starts accepting Token-2022, this test fails and the workaround can
        // be reconsidered.
        let token_2022 = Pubkey::from_str(TOKEN_2022_PROGRAM_ID).unwrap();
        let pk = Pubkey::new_unique();
        assert!(
            spl_token::instruction::close_account(&token_2022, &pk, &pk, &pk, &[]).is_err(),
            "spl_token::close_account now accepts Token-2022; drop close_account_ix"
        );
    }

    #[test]
    fn token_account_layout_offsets_match_spl_token() {
        use solana_sdk::program_pack::Pack;
        use spl_token::state::Account as SplAccount;
        assert_eq!(SplAccount::LEN, ACCOUNT_LEN);
        // mint(32) + owner(32) puts amount at 64; delegate COption<Pubkey>(36)
        // then puts state at 108, is_native(12) and delegated_amount(8) put
        // close_authority at 129.
        assert_eq!(AMOUNT_OFFSET, 32 + 32);
        assert_eq!(STATE_OFFSET, 32 + 32 + 8 + 36);
        assert_eq!(CLOSE_AUTHORITY_OFFSET, STATE_OFFSET + 1 + 12 + 8);
    }

    #[test]
    fn batches_stay_within_transaction_limits() {
        // 20 closes plus the fee payer and program ids stays well under the
        // 1232-byte packet limit; this guards against bumping the constant.
        const { assert!(CLOSES_PER_TX * 32 + 256 < 1232) };
    }
}
