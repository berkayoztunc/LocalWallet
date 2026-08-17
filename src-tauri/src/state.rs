//! Shared application state.
//!
//! Key material lives here and nowhere else. It is never returned from a
//! command, never serialized to the webview, and is zeroized when the vault
//! locks. Commands that need to sign take a short-lived copy of the keypairs
//! out of the lock (the mutex is a std `Mutex`, so it must not be held across
//! an `.await`) and drop it as soon as signing is done.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
    /// Cached validator directory. Lives here so one fetch serves the whole
    /// session rather than one per view.
    pub validator_directory: crate::validators::DirectoryCache,
    /// SOL/USD for the menu bar, refreshed at most once a minute.
    pub prices: crate::menubar::PriceCache,
    /// The one wallet, if any, currently cleared for Privacy Cash.
    privacy_grant: Mutex<Option<PrivacyGrant>>,
}

/// Permission to hand one wallet's shielded-pool credential to the webview.
///
/// The credential is spend authority over that wallet's shielded balance (see
/// `crate::privacy`), so the interface must not be able to help itself to one
/// per wallet. A grant covers exactly one wallet, is issued only after the user
/// approves a native dialog, allows a single sign-in, and expires.
///
/// Kept here rather than in the webview for the obvious reason: the webview is
/// the party this is defending against.
pub struct PrivacyGrant {
    pubkey: String,
    expires_at: Instant,
    sign_in_used: bool,
}

/// Long enough to shield, check a balance and send without re-approving;
/// short enough that walking away does not leave the door open.
const PRIVACY_GRANT_TTL: Duration = Duration::from_secs(15 * 60);

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

    /// Build one directly from key bytes, so signing can be tested without a
    /// vault. The real constructor is `AppState::signing_keys`.
    #[cfg(test)]
    pub fn for_test(label: String, pubkey: String, secret: [u8; 64]) -> Self {
        Self {
            label,
            pubkey,
            secret: Zeroizing::new(secret),
        }
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
        // A grant outliving the vault it was approved against would let the
        // next person to sit down mint a pool credential without a password.
        self.revoke_privacy_grant();
    }

    /// Record that the user approved Privacy Cash for `pubkey`.
    ///
    /// Overwrites any previous grant, so exactly one wallet is authorized at a
    /// time by construction rather than by bookkeeping.
    pub fn grant_privacy(&self, pubkey: String) {
        *self.privacy_grant.lock().unwrap() = Some(PrivacyGrant {
            pubkey,
            expires_at: Instant::now() + PRIVACY_GRANT_TTL,
            sign_in_used: false,
        });
    }

    pub fn revoke_privacy_grant(&self) {
        *self.privacy_grant.lock().unwrap() = None;
    }

    /// Drop the grant if it covers `pubkey`, used when a wallet leaves the
    /// vault so a later wallet cannot inherit its approval.
    pub fn revoke_privacy_grant_for(&self, pubkey: &str) {
        let mut guard = self.privacy_grant.lock().unwrap();
        if guard.as_ref().is_some_and(|g| g.pubkey == pubkey) {
            *guard = None;
        }
    }

    /// Consume the single sign-in a grant allows.
    ///
    /// Separate from [`Self::check_privacy_grant`] because the sign-in
    /// signature is the durable credential — one approval must not mint two.
    pub fn take_privacy_sign_in(&self, pubkey: &str) -> Result<()> {
        let mut guard = self.privacy_grant.lock().unwrap();
        let grant = guard.as_mut().ok_or_else(Self::no_privacy_grant)?;
        if grant.pubkey != pubkey || Instant::now() >= grant.expires_at {
            return Err(Self::no_privacy_grant());
        }
        if grant.sign_in_used {
            return Err(AppError::invalid(
                "this wallet's Privacy Cash access has already been used; approve it again",
            ));
        }
        grant.sign_in_used = true;
        Ok(())
    }

    /// Check a grant covers `pubkey` without consuming it. Deposits may repeat
    /// within the window; each one is still shown to the user before it is sent.
    pub fn check_privacy_grant(&self, pubkey: &str) -> Result<()> {
        let guard = self.privacy_grant.lock().unwrap();
        let grant = guard.as_ref().ok_or_else(Self::no_privacy_grant)?;
        if grant.pubkey != pubkey || Instant::now() >= grant.expires_at {
            return Err(Self::no_privacy_grant());
        }
        Ok(())
    }

    fn no_privacy_grant() -> AppError {
        AppError::invalid(
            "Privacy Cash access for this wallet has not been approved, or has expired",
        )
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

#[cfg(test)]
mod tests {
    use super::*;

    /// One approval must not mint two pool credentials: the signature is a
    /// durable bearer secret, so a second one is a second thing to leak.
    #[test]
    fn a_grant_allows_one_sign_in() {
        let state = AppState::default();
        state.grant_privacy("wallet".to_string());

        assert!(state.take_privacy_sign_in("wallet").is_ok());
        assert!(state.take_privacy_sign_in("wallet").is_err());
    }

    #[test]
    fn a_grant_covers_only_the_wallet_it_was_approved_for() {
        let state = AppState::default();
        state.grant_privacy("approved".to_string());

        assert!(state.take_privacy_sign_in("other").is_err());
        assert!(state.check_privacy_grant("other").is_err());
        assert!(state.check_privacy_grant("approved").is_ok());
    }

    /// Approving a second wallet replaces the first, so the interface cannot
    /// accumulate credentials for the whole vault.
    #[test]
    fn granting_again_replaces_the_previous_wallet() {
        let state = AppState::default();
        state.grant_privacy("first".to_string());
        state.grant_privacy("second".to_string());

        assert!(state.check_privacy_grant("first").is_err());
        assert!(state.check_privacy_grant("second").is_ok());
    }

    #[test]
    fn deposits_may_repeat_within_the_window() {
        let state = AppState::default();
        state.grant_privacy("wallet".to_string());

        assert!(state.check_privacy_grant("wallet").is_ok());
        assert!(state.check_privacy_grant("wallet").is_ok());
    }

    #[test]
    fn locking_the_vault_revokes_the_grant() {
        let state = AppState::default();
        state.grant_privacy("wallet".to_string());
        state.lock_vault();

        assert!(state.check_privacy_grant("wallet").is_err());
    }

    #[test]
    fn removing_the_wallet_revokes_its_grant() {
        let state = AppState::default();
        state.grant_privacy("wallet".to_string());

        state.revoke_privacy_grant_for("someone-else");
        assert!(state.check_privacy_grant("wallet").is_ok());

        state.revoke_privacy_grant_for("wallet");
        assert!(state.check_privacy_grant("wallet").is_err());
    }

    #[test]
    fn an_expired_grant_is_refused() {
        let state = AppState::default();
        *state.privacy_grant.lock().unwrap() = Some(PrivacyGrant {
            pubkey: "wallet".to_string(),
            expires_at: Instant::now() - Duration::from_secs(1),
            sign_in_used: false,
        });

        assert!(state.check_privacy_grant("wallet").is_err());
        assert!(state.take_privacy_sign_in("wallet").is_err());
    }
}
