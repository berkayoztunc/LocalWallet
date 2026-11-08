//! Touch ID unlock.
//!
//! The vault's derived key (not the password) is kept in the login keychain and
//! is read back only after a LocalAuthentication biometric check succeeds.
//!
//! Be clear about what that protects. The biometric check is enforced by this
//! app, not by the keychain: the item uses the ordinary login keychain, whose
//! access control is "this app's code signature". Hardware-bound protection
//! (an access-control flag that makes the Secure Enclave demand the fingerprint
//! itself) needs the data-protection keychain, which needs a signing identity
//! with keychain entitlements. This app is ad-hoc signed, so that is not
//! available; the README says so.
//!
//! Because the key, not the password, is stored, changing the password
//! invalidates it, and `vault_change_password` deletes the item.
//!
//! On non-macOS targets everything here reports "unavailable".

/// Keychain service/account for the stored vault key.
#[cfg(target_os = "macos")]
const SERVICE: &str = "com.localwallet.app";
#[cfg(target_os = "macos")]
const ACCOUNT: &str = "vault-key";

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };
    use zeroize::Zeroizing;

    use super::{ACCOUNT, SERVICE};
    use crate::error::{AppError, Result};

    const POLICY: LAPolicy = LAPolicy::DeviceOwnerAuthenticationWithBiometrics;

    pub fn available() -> bool {
        // SAFETY: plain Objective-C message sends on a context we own.
        unsafe { LAContext::new().canEvaluatePolicy_error(POLICY).is_ok() }
    }

    /// Show the system Touch ID sheet and wait for the answer. Blocks, so it
    /// must run off the thread driving the UI.
    pub fn prompt(reason: &str) -> Result<()> {
        let (tx, rx) = mpsc::channel::<std::result::Result<(), String>>();
        let reply = RcBlock::new(move |ok: Bool, err: *mut NSError| {
            let outcome = if ok.as_bool() {
                Ok(())
            } else if err.is_null() {
                Err("Touch ID was not approved".to_string())
            } else {
                // SAFETY: LocalAuthentication passes a valid NSError when `ok`
                // is false, alive for the duration of this callback.
                Err(unsafe { (*err).localizedDescription().to_string() })
            };
            let _ = tx.send(outcome);
        });
        let reason = NSString::from_str(reason);
        // The context must outlive the evaluation, so it is held until the
        // reply arrives.
        let ctx = unsafe { LAContext::new() };
        unsafe { ctx.evaluatePolicy_localizedReason_reply(POLICY, &reason, &reply) };
        let outcome = rx
            .recv_timeout(Duration::from_secs(120))
            .map_err(|_| AppError::invalid("Touch ID timed out"))?;
        drop(ctx);
        outcome.map_err(AppError::invalid)
    }

    pub fn store_key(key: &[u8; 32]) -> Result<()> {
        set_generic_password(SERVICE, ACCOUNT, key)
            .map_err(|e| AppError::invalid(format!("could not save to the keychain: {e}")))
    }

    pub fn load_key() -> Result<Option<Zeroizing<[u8; 32]>>> {
        match get_generic_password(SERVICE, ACCOUNT) {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                let key: [u8; 32] = bytes
                    .as_slice()
                    .try_into()
                    .map_err(|_| AppError::invalid("the keychain entry is not a vault key"))?;
                Ok(Some(Zeroizing::new(key)))
            }
            // errSecItemNotFound
            Err(e) if e.code() == -25300 => Ok(None),
            Err(e) => Err(AppError::invalid(format!(
                "could not read the keychain: {e}"
            ))),
        }
    }

    pub fn delete_key() {
        let _ = delete_generic_password(SERVICE, ACCOUNT);
    }

    /// Whether the item exists, asked for attributes only: reading the secret
    /// itself can raise a keychain prompt, and this runs on every launch.
    pub fn has_key() -> bool {
        ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(SERVICE)
            .account(ACCOUNT)
            .limit(Limit::Max(1))
            .load_attributes(true)
            .search()
            .map(|r| !r.is_empty())
            .unwrap_or(false)
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use zeroize::Zeroizing;

    use crate::error::{AppError, Result};

    pub fn available() -> bool {
        false
    }
    pub fn prompt(_reason: &str) -> Result<()> {
        Err(AppError::invalid("Touch ID is only available on macOS"))
    }
    pub fn store_key(_key: &[u8; 32]) -> Result<()> {
        Err(AppError::invalid("Touch ID is only available on macOS"))
    }
    pub fn load_key() -> Result<Option<Zeroizing<[u8; 32]>>> {
        Ok(None)
    }
    pub fn delete_key() {}
    pub fn has_key() -> bool {
        false
    }
}

pub use imp::{available, delete_key, has_key, load_key, prompt, store_key};
