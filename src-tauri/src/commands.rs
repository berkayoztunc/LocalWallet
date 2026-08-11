//! The IPC surface.
//!
//! Note what is *not* here: no command returns a private key. The webview only
//! ever receives public keys, balances, signatures and errors.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, Result};
use crate::funded_cleanup::{self, FundedCleanupPlan, FundedCleanupProgress};
use crate::keys::{self, ImportLineError, ImportReport};
use crate::rpc::{self, RpcHealth};
use crate::settings::Settings;
use crate::stake::{self, StakeProgress, StakeQuote, StakeScan};
use crate::state::{AppState, Unlocked};
use crate::sweep::{self, SendQuote, SendResult, SweepPlan, SweepProgress};
use crate::tokens::{self, CleanupPreview, CleanupProgress, TokenScan};
use crate::validators::{self, ValidatorList};
use crate::vault::{self, StoredWallet};

pub const SWEEP_EVENT: &str = "sweep://progress";
pub const CLEANUP_EVENT: &str = "cleanup://progress";
pub const FUNDED_CLEANUP_EVENT: &str = "funded-cleanup://progress";
pub const STAKE_EVENT: &str = "stake://progress";

fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Io(format!("cannot resolve app data dir: {e}")))
}

/// Argon2id is deliberately slow. Running it on a blocking thread keeps the
/// window responsive while the vault is being opened.
async fn blocking<T, F>(f: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(format!("background task failed: {e}")))?
}

#[derive(Serialize)]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
    pub wallet_count: usize,
}

#[derive(Serialize)]
pub struct WalletView {
    pub label: String,
    pub pubkey: String,
    pub added_at: i64,
}

#[derive(Serialize)]
pub struct BalanceView {
    pub pubkey: String,
    pub lamports: Option<u64>,
}

#[derive(Deserialize)]
pub struct ImportRequest {
    pub text: String,
    pub label_prefix: Option<String>,
}

#[tauri::command]
pub async fn vault_status(app: AppHandle, state: State<'_, AppState>) -> Result<VaultStatus> {
    let dir = data_dir(&app)?;
    let unlocked = state.is_unlocked();
    let wallet_count = if unlocked {
        state.with_vault(|u| Ok(u.data.wallets.len()))?
    } else {
        0
    };
    Ok(VaultStatus {
        exists: vault::exists(&dir),
        unlocked,
        wallet_count,
    })
}

#[tauri::command]
pub async fn vault_create(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<VaultStatus> {
    let dir = data_dir(&app)?;
    let created = {
        let dir = dir.clone();
        blocking(move || vault::create(&dir, &password)).await?
    };
    state.set_unlocked(Unlocked {
        data: created.0,
        key: created.1,
        salt: created.2,
    });
    Ok(VaultStatus {
        exists: true,
        unlocked: true,
        wallet_count: 0,
    })
}

#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<VaultStatus> {
    let dir = data_dir(&app)?;
    let opened = {
        let dir = dir.clone();
        blocking(move || vault::unlock(&dir, &password)).await?
    };
    let count = opened.0.wallets.len();
    state.set_unlocked(Unlocked {
        data: opened.0,
        key: opened.1,
        salt: opened.2,
    });
    Ok(VaultStatus {
        exists: true,
        unlocked: true,
        wallet_count: count,
    })
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, AppState>) -> Result<()> {
    state.lock_vault();
    Ok(())
}

#[tauri::command]
pub async fn vault_change_password(
    app: AppHandle,
    state: State<'_, AppState>,
    old_password: String,
    new_password: String,
) -> Result<()> {
    let dir = data_dir(&app)?;
    // Requires the vault to already be open, so a locked app cannot be used to
    // brute-force the old password through this path.
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let reopened =
        blocking(move || vault::change_password(&dir, &old_password, &new_password)).await?;
    state.set_unlocked(Unlocked {
        data: reopened.0,
        key: reopened.1,
        salt: reopened.2,
    });
    Ok(())
}

#[tauri::command]
pub async fn vault_export(app: AppHandle, destination: String) -> Result<String> {
    let dir = data_dir(&app)?;
    let dest = PathBuf::from(&destination);
    vault::export(&dir, &dest)?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn wallets_list(state: State<'_, AppState>) -> Result<Vec<WalletView>> {
    state.with_vault(|u| {
        Ok(u.data
            .wallets
            .iter()
            .map(|w| WalletView {
                label: w.label.clone(),
                pubkey: w.pubkey.clone(),
                added_at: w.added_at,
            })
            .collect())
    })
}

#[tauri::command]
pub async fn wallets_import(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ImportRequest,
) -> Result<ImportReport> {
    let dir = data_dir(&app)?;
    let entries = keys::split_entries(&request.text);
    if entries.is_empty() {
        return Err(AppError::invalid("nothing to import"));
    }

    state.with_vault_mut(&dir, |data| {
        let mut report = ImportReport::default();
        let prefix = request
            .label_prefix
            .clone()
            .unwrap_or_else(|| "Wallet".to_string());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default();

        for (line, entry) in entries {
            match keys::parse_secret(&entry) {
                Ok((secret, pubkey)) => {
                    if data.wallets.iter().any(|w| w.pubkey == pubkey) {
                        report.duplicates += 1;
                        continue;
                    }
                    let index = data.wallets.len() + 1;
                    data.wallets.push(StoredWallet {
                        label: format!("{prefix} {index}"),
                        pubkey,
                        secret,
                        added_at: now,
                    });
                    report.imported += 1;
                }
                Err(e) => report.failed.push(ImportLineError {
                    line,
                    message: e.to_string(),
                    preview: keys::mask(&entry),
                }),
            }
        }
        Ok(report)
    })
}

#[tauri::command]
pub async fn wallets_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    pubkey: String,
) -> Result<()> {
    let dir = data_dir(&app)?;
    state.with_vault_mut(&dir, |data| {
        let before = data.wallets.len();
        data.wallets.retain(|w| w.pubkey != pubkey);
        if data.wallets.len() == before {
            return Err(AppError::UnknownWallet(pubkey.clone()));
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn wallets_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    pubkey: String,
    label: String,
) -> Result<()> {
    let dir = data_dir(&app)?;
    state.with_vault_mut(&dir, |data| {
        let wallet = data
            .wallets
            .iter_mut()
            .find(|w| w.pubkey == pubkey)
            .ok_or_else(|| AppError::UnknownWallet(pubkey.clone()))?;
        wallet.label = label.trim().to_string();
        Ok(())
    })
}

#[tauri::command]
pub async fn balances_refresh(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<BalanceView>> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let pubkeys: Vec<String> = state.with_vault(|u| {
        Ok(u.data
            .wallets
            .iter()
            .map(|w| w.pubkey.clone())
            .collect::<Vec<_>>())
    })?;
    if pubkeys.is_empty() {
        return Ok(vec![]);
    }

    let parsed: Vec<_> = pubkeys
        .iter()
        .map(|p| rpc::parse_pubkey(p))
        .collect::<Result<Vec<_>>>()?;
    let client = rpc::client(&settings);
    let balances = rpc::fetch_balances(client, &parsed, settings.concurrency).await;

    Ok(balances
        .into_iter()
        .map(|(pk, lamports)| BalanceView {
            pubkey: pk.to_string(),
            lamports,
        })
        .collect())
}

#[tauri::command]
pub async fn settings_get(app: AppHandle, state: State<'_, AppState>) -> Result<Settings> {
    let dir = data_dir(&app)?;
    Ok(state.settings(&dir))
}

#[tauri::command]
pub async fn settings_set(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings> {
    let dir = data_dir(&app)?;
    state.set_settings(&dir, settings)
}

#[tauri::command]
pub async fn rpc_test(url: String) -> Result<RpcHealth> {
    Ok(rpc::test_endpoint(&url).await)
}

/// Full token inventory: every token account per wallet with its balance.
/// This costs two RPC calls per wallet, so it is an explicit action rather
/// than something that runs on every dashboard load.
#[tauri::command]
pub async fn tokens_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    pubkeys: Option<Vec<String>>,
) -> Result<TokenScan> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let keys = state.signing_keys(pubkeys.as_deref())?;
    let client = rpc::client(&settings);
    tokens::scan(client, &keys, settings.concurrency).await
}

#[tauri::command]
pub async fn cleanup_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    pubkeys: Option<Vec<String>>,
) -> Result<CleanupPreview> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let keys = state.signing_keys(pubkeys.as_deref())?;
    let client = rpc::client(&settings);
    tokens::preview(client, &keys, settings.concurrency).await
}

#[tauri::command]
pub async fn cleanup_run(
    app: AppHandle,
    state: State<'_, AppState>,
    pubkeys: Option<Vec<String>>,
) -> Result<Vec<CleanupProgress>> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let keys = state.signing_keys(pubkeys.as_deref())?;
    let client = rpc::client(&settings);
    let emitter = app.clone();
    tokens::run(client, keys, settings.concurrency, move |p| {
        let _ = emitter.emit(CLEANUP_EVENT, p);
    })
    .await
}

/// Every stake account the vault's wallets control. Two RPC calls per wallet,
/// so the UI drives this from an explicit action.
#[tauri::command]
pub async fn stake_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    pubkeys: Option<Vec<String>>,
) -> Result<StakeScan> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let keys = state.signing_keys(pubkeys.as_deref())?;
    let client = rpc::client(&settings);
    stake::scan(client, &keys, settings.concurrency).await
}

/// What a wallet can stake right now, and what it costs. Read-only.
#[tauri::command]
pub async fn stake_quote(
    app: AppHandle,
    state: State<'_, AppState>,
    owner: String,
) -> Result<StakeQuote> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let client = rpc::client(&settings);
    stake::quote(client, &owner, settings.priority_fee_microlamports).await
}

/// Create a stake account and delegate it to a validator, in one transaction.
#[tauri::command]
pub async fn stake_delegate(
    app: AppHandle,
    state: State<'_, AppState>,
    owner: String,
    vote_account: String,
    lamports: u64,
) -> Result<StakeProgress> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let key = signing_key(&state, &owner)?;
    let client = rpc::client(&settings);

    let progress = match stake::create_and_delegate(
        client,
        &key,
        &vote_account,
        lamports,
        settings.priority_fee_microlamports,
    )
    .await
    {
        Ok((signature, address)) => StakeProgress {
            address,
            label: key.label.clone(),
            status: "delegated".into(),
            lamports,
            signature: Some(signature),
            error: None,
            done: 1,
            total: 1,
        },
        Err(e) => StakeProgress {
            address: String::new(),
            label: key.label.clone(),
            status: "failed".into(),
            lamports: 0,
            signature: None,
            error: Some(e.to_string()),
            done: 1,
            total: 1,
        },
    };
    let _ = app.emit(STAKE_EVENT, progress.clone());
    Ok(progress)
}

/// Begin cooldown on one or more stake accounts. Each is a separate
/// transaction, so a failure on one never blocks the rest.
#[tauri::command]
pub async fn stake_deactivate(
    app: AppHandle,
    state: State<'_, AppState>,
    accounts: Vec<(String, String)>,
) -> Result<Vec<StakeProgress>> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let client = rpc::client(&settings);
    let total = accounts.len();
    let mut out = Vec::with_capacity(total);

    for (done, (owner, stake_account)) in accounts.into_iter().enumerate() {
        let key = signing_key(&state, &owner)?;
        let progress = match stake::deactivate(client.clone(), &key, &stake_account).await {
            Ok(signature) => StakeProgress {
                address: stake_account,
                label: key.label.clone(),
                status: "deactivated".into(),
                lamports: 0,
                signature: Some(signature),
                error: None,
                done: done + 1,
                total,
            },
            Err(e) => StakeProgress {
                address: stake_account,
                label: key.label.clone(),
                status: "failed".into(),
                lamports: 0,
                signature: None,
                error: Some(e.to_string()),
                done: done + 1,
                total,
            },
        };
        let _ = app.emit(STAKE_EVENT, progress.clone());
        out.push(progress);
    }
    Ok(out)
}

/// Withdraw a cooled-down stake account back to its owning wallet.
#[tauri::command]
pub async fn stake_withdraw(
    app: AppHandle,
    state: State<'_, AppState>,
    owner: String,
    stake_account: String,
    destination: Option<String>,
) -> Result<StakeProgress> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let key = signing_key(&state, &owner)?;
    let client = rpc::client(&settings);
    // Default to the owning wallet: the stake came from there, and sending it
    // anywhere else should be a deliberate, separate step.
    let destination = destination.unwrap_or_else(|| owner.clone());

    let progress = match stake::withdraw(client, &key, &stake_account, &destination).await {
        Ok((signature, lamports)) => StakeProgress {
            address: stake_account,
            label: key.label.clone(),
            status: "withdrawn".into(),
            lamports,
            signature: Some(signature),
            error: None,
            done: 1,
            total: 1,
        },
        Err(e) => StakeProgress {
            address: stake_account,
            label: key.label.clone(),
            status: "failed".into(),
            lamports: 0,
            signature: None,
            error: Some(e.to_string()),
            done: 1,
            total: 1,
        },
    };
    let _ = app.emit(STAKE_EVENT, progress.clone());
    Ok(progress)
}

/// Every validator, with authoritative numbers from your RPC and optional
/// names from the public directory.
#[tauri::command]
pub async fn validators_list(app: AppHandle, state: State<'_, AppState>) -> Result<ValidatorList> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let client = rpc::client(&settings);
    validators::list(
        client,
        &state.validator_directory,
        settings.validator_directory,
    )
    .await
}

/// Preview a fund -> close -> return run: which wallets can be rescued, what
/// the funder must lend, and what it all costs.
#[tauri::command]
pub async fn funded_cleanup_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    funder: String,
    pubkeys: Option<Vec<String>>,
) -> Result<FundedCleanupPlan> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let destination = settings.destination_pubkey.clone().unwrap_or_default();
    let funder_key = signing_key(&state, &funder)?;
    let targets = state.signing_keys(pubkeys.as_deref())?;
    let client = rpc::client(&settings);
    funded_cleanup::plan(
        client,
        &funder_key,
        &targets,
        &destination,
        settings.priority_fee_microlamports,
        settings.concurrency,
    )
    .await
}

#[tauri::command]
pub async fn funded_cleanup_run(
    app: AppHandle,
    state: State<'_, AppState>,
    funder: String,
    pubkeys: Option<Vec<String>>,
) -> Result<Vec<FundedCleanupProgress>> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let destination = settings.destination_pubkey.clone().unwrap_or_default();
    let funder_key = signing_key(&state, &funder)?;
    let targets = state.signing_keys(pubkeys.as_deref())?;
    let client = rpc::client(&settings);
    let emitter = app.clone();
    funded_cleanup::run(
        client,
        funder_key,
        targets,
        destination,
        settings.priority_fee_microlamports,
        settings.concurrency,
        move |p| {
            let _ = emitter.emit(FUNDED_CLEANUP_EVENT, p);
        },
    )
    .await
}

/// Price a single transfer. `lamports = null` means send the whole balance.
#[tauri::command]
pub async fn send_quote(
    app: AppHandle,
    state: State<'_, AppState>,
    from: String,
    destination: String,
    lamports: Option<u64>,
) -> Result<SendQuote> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let client = rpc::client(&settings);
    sweep::send_quote(
        client,
        &from,
        &destination,
        lamports,
        settings.priority_fee_microlamports,
    )
    .await
}

fn signing_key(state: &State<'_, AppState>, pubkey: &str) -> Result<crate::state::SigningKey> {
    let keys = state.signing_keys(Some(&[pubkey.to_string()]))?;
    keys.into_iter()
        .next()
        .ok_or_else(|| AppError::UnknownWallet(pubkey.to_string()))
}

#[tauri::command]
pub async fn send_sol(
    app: AppHandle,
    state: State<'_, AppState>,
    from: String,
    destination: String,
    lamports: Option<u64>,
) -> Result<SendResult> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let key = signing_key(&state, &from)?;
    let client = rpc::client(&settings);
    sweep::send(
        client,
        &key,
        &destination,
        lamports,
        settings.priority_fee_microlamports,
    )
    .await
}

#[tauri::command]
pub async fn sweep_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    destination: String,
    pubkeys: Option<Vec<String>>,
) -> Result<SweepPlan> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let keys = state.signing_keys(pubkeys.as_deref())?;
    let client = rpc::client(&settings);
    sweep::plan(
        client,
        &keys,
        &destination,
        settings.priority_fee_microlamports,
        settings.concurrency,
    )
    .await
}

#[tauri::command]
pub async fn sweep_run(
    app: AppHandle,
    state: State<'_, AppState>,
    destination: String,
    pubkeys: Option<Vec<String>>,
) -> Result<Vec<SweepProgress>> {
    let dir = data_dir(&app)?;
    let settings = state.settings(&dir);
    let keys = state.signing_keys(pubkeys.as_deref())?;
    let client = rpc::client(&settings);
    let emitter = app.clone();
    sweep::run(
        client,
        keys,
        &destination,
        settings.priority_fee_microlamports,
        settings.concurrency,
        move |p| {
            let _ = emitter.emit(SWEEP_EVENT, p);
        },
    )
    .await
}
