//! Shared application state.
//!
//! Key material lives here and nowhere else. It is never returned from a
//! command, never serialized to the webview, and is zeroized when the vault
//! locks. Commands that need to sign take a short-lived copy of the keypairs
//! out of the lock (the mutex is a std `Mutex`, so it must not be held across
//! an `.await`) and drop it as soon as signing is done.

use std::path::Path;
use std::sync::Mutex;

use solana_sdk::signer::keypair::Keypair;
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use crate::settings::Settings;
use crate::vault::{StoredWallet, VaultData, VaultKey};

pub struct Unlocked {
    pub data: VaultData,
    pub key: VaultKey,
    pub salt: [u8; 16],
}

#[derive(Default)]
pub struct AppState {
    unlocked: Mutex<Option<Unlocked>>,
    settings: Mutex<Option<Settings>>,
}

/// A keypair pulled out of the vault for signing. Dropping it zeroizes the
/// secret bytes; the `Keypair` itself is rebuilt on demand.
pub struct SigningKey {
    pub label: String,
    pub pubkey: String,
    secret: Zeroizing<[u8; 64]>,
}

impl SigningKey {
    pub fn keypair(&self) -> Result<Keypair> {
        Keypair::try_from(&self.secret[..])
            .map_err(|_| AppError::invalid("stored key is not a valid keypair"))
    }
}

impl AppState {
    pub fn set_unlocked(&self, unlocked: Unlocked) {
        *self.unlocked.lock().unwrap() = Some(unlocked);
    }

    pub fn lock_vault(&self) {
        // Dropping `Unlocked` zeroizes both the derived key (`Zeroizing`) and
        // every stored secret (`StoredWallet::drop`).
        *self.unlocked.lock().unwrap() = None;
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked.lock().unwrap().is_some()
    }

    /// Run `f` against the decrypted vault. Returns `Locked` if the vault is
    /// not open, which the UI turns into a redirect to the unlock screen.
    pub fn with_vault<T>(&self, f: impl FnOnce(&Unlocked) -> Result<T>) -> Result<T> {
        let guard = self.unlocked.lock().unwrap();
        let unlocked = guard.as_ref().ok_or(AppError::Locked)?;
        f(unlocked)
    }

    /// Mutate the vault in memory and persist it in the same critical section,
    /// so an in-memory change can never diverge from what is on disk.
    pub fn with_vault_mut<T>(
        &self,
        data_dir: &Path,
        f: impl FnOnce(&mut VaultData) -> Result<T>,
    ) -> Result<T> {
        let mut guard = self.unlocked.lock().unwrap();
        let unlocked = guard.as_mut().ok_or(AppError::Locked)?;
        let out = f(&mut unlocked.data)?;
        crate::vault::save(data_dir, &unlocked.data, &unlocked.key, unlocked.salt)?;
        Ok(out)
    }

    /// Take signing keys for the given pubkeys (or all wallets when `None`).
    /// The lock is released before any async work begins.
    pub fn signing_keys(&self, only: Option<&[String]>) -> Result<Vec<SigningKey>> {
        self.with_vault(|u| {
            let selected: Vec<&StoredWallet> = match only {
                None => u.data.wallets.iter().collect(),
                Some(list) => {
                    let mut out = Vec::with_capacity(list.len());
                    for pk in list {
                        let w = u
                            .data
                            .wallets
                            .iter()
                            .find(|w| &w.pubkey == pk)
                            .ok_or_else(|| AppError::UnknownWallet(pk.clone()))?;
                        out.push(w);
                    }
                    out
                }
            };
            Ok(selected
                .into_iter()
                .map(|w| SigningKey {
                    label: w.label.clone(),
                    pubkey: w.pubkey.clone(),
                    secret: Zeroizing::new(w.secret),
                })
                .collect())
        })
    }

    pub fn settings(&self, data_dir: &Path) -> Settings {
        let mut guard = self.settings.lock().unwrap();
        if guard.is_none() {
            *guard = Some(crate::settings::load(data_dir));
        }
        guard.as_ref().unwrap().clone()
    }

    pub fn set_settings(&self, data_dir: &Path, settings: Settings) -> Result<Settings> {
        let settings = settings.sanitized();
        crate::settings::save(data_dir, &settings)?;
        *self.settings.lock().unwrap() = Some(settings.clone());
        Ok(settings)
    }
}
