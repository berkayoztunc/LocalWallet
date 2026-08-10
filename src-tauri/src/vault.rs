//! Encrypted key vault.
//!
//! File layout of `vault.bin`:
//!
//! ```text
//! magic   8 bytes   b"LWVAULT1"
//! version 1 byte    format version (currently 1)
//! m_cost  4 bytes   argon2id memory cost, KiB, little endian
//! t_cost  4 bytes   argon2id time cost, little endian
//! p_cost  4 bytes   argon2id parallelism, little endian
//! salt    16 bytes  argon2id salt
//! nonce   24 bytes  XChaCha20-Poly1305 nonce
//! body    remainder ciphertext + 16 byte poly1305 tag
//! ```
//!
//! The whole wallet list is encrypted as one blob, so the file leaks neither
//! the wallet count nor the labels. Only the KDF parameters are cleartext,
//! because they are needed to re-derive the key.

use std::fs;
use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{AppError, Result};

const MAGIC: &[u8; 8] = b"LWVAULT1";
const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 8 + 1 + 4 + 4 + 4 + SALT_LEN + NONCE_LEN;

/// Argon2id parameters. 64 MiB / 3 passes costs roughly half a second on a
/// laptop, which is the brute-force resistance for the unlock screen.
const M_COST: u32 = 65536; // KiB
const T_COST: u32 = 3;
const P_COST: u32 = 1;

pub const MIN_PASSWORD_LEN: usize = 8;

/// One stored keypair. `secret` is the full 64-byte ed25519 keypair
/// (32-byte seed followed by the 32-byte public key).
#[derive(Clone, Serialize, Deserialize)]
pub struct StoredWallet {
    pub label: String,
    pub pubkey: String,
    #[serde(with = "secret_bytes")]
    pub secret: [u8; 64],
    pub added_at: i64,
}

impl Drop for StoredWallet {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

mod secret_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8; 64], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&bs58::encode(v).into_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 64], D::Error> {
        let s = String::deserialize(d)?;
        let bytes = bs58::decode(&s)
            .into_vec()
            .map_err(serde::de::Error::custom)?;
        let arr: [u8; 64] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| serde::de::Error::custom("secret key must be 64 bytes"))?;
        Ok(arr)
    }
}

#[derive(Default, Serialize, Deserialize)]
pub struct VaultData {
    pub wallets: Vec<StoredWallet>,
}

/// The derived symmetric key, held only while the vault is unlocked.
pub type VaultKey = Zeroizing<[u8; 32]>;

struct KdfParams {
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    salt: [u8; SALT_LEN],
}

fn derive_key(password: &str, p: &KdfParams) -> Result<VaultKey> {
    let params = Params::new(p.m_cost, p.t_cost, p.p_cost, Some(32))
        .map_err(|e| AppError::invalid(format!("argon2 params: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), &p.salt, key.as_mut())
        .map_err(|e| AppError::invalid(format!("key derivation failed: {e}")))?;
    Ok(key)
}

fn cipher(key: &VaultKey) -> Result<XChaCha20Poly1305> {
    XChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|e| AppError::invalid(format!("cipher init: {e}")))
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::thread_rng().fill_bytes(&mut b);
    b
}

pub fn vault_path(data_dir: &Path) -> PathBuf {
    data_dir.join("vault.bin")
}

pub fn exists(data_dir: &Path) -> bool {
    vault_path(data_dir).is_file()
}

/// Serialize + encrypt + write atomically. A fresh nonce is generated on every
/// write, which is required: reusing a nonce with the same key would leak
/// plaintext.
pub fn save(data_dir: &Path, data: &VaultData, key: &VaultKey, salt: [u8; SALT_LEN]) -> Result<()> {
    let mut plaintext = serde_json::to_vec(data)?;
    let nonce_bytes: [u8; NONCE_LEN] = random_bytes();
    let ciphertext = cipher(key)?
        .encrypt(&XNonce::from(nonce_bytes), plaintext.as_slice())
        .map_err(|_| AppError::invalid("encryption failed"))?;
    plaintext.zeroize();

    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&M_COST.to_le_bytes());
    out.extend_from_slice(&T_COST.to_le_bytes());
    out.extend_from_slice(&P_COST.to_le_bytes());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);

    write_atomic(&vault_path(data_dir), &out)
}

/// Write via temp file + rename so a crash mid-write cannot leave a truncated
/// vault behind. Both files live in the same directory, so the rename is atomic.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn read_header(bytes: &[u8]) -> Result<(KdfParams, [u8; NONCE_LEN], usize)> {
    if bytes.len() < HEADER_LEN || &bytes[..8] != MAGIC {
        return Err(AppError::CorruptVault);
    }
    if bytes[8] != VERSION {
        return Err(AppError::CorruptVault);
    }
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let salt: [u8; SALT_LEN] = bytes[21..21 + SALT_LEN].try_into().unwrap();
    let nonce: [u8; NONCE_LEN] = bytes[21 + SALT_LEN..HEADER_LEN].try_into().unwrap();
    Ok((
        KdfParams {
            m_cost: u32_at(9),
            t_cost: u32_at(13),
            p_cost: u32_at(17),
            salt,
        },
        nonce,
        HEADER_LEN,
    ))
}

/// Create a brand new vault. Fails if one already exists so an existing vault
/// can never be silently destroyed.
pub fn create(data_dir: &Path, password: &str) -> Result<(VaultData, VaultKey, [u8; SALT_LEN])> {
    if exists(data_dir) {
        return Err(AppError::VaultExists);
    }
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::WeakPassword);
    }
    let salt: [u8; SALT_LEN] = random_bytes();
    let key = derive_key(
        password,
        &KdfParams {
            m_cost: M_COST,
            t_cost: T_COST,
            p_cost: P_COST,
            salt,
        },
    )?;
    let data = VaultData::default();
    save(data_dir, &data, &key, salt)?;
    Ok((data, key, salt))
}

/// Decrypt the vault. A wrong password fails the poly1305 tag check, which is
/// how `BadPassword` is detected - there is no password hash stored anywhere.
pub fn unlock(data_dir: &Path, password: &str) -> Result<(VaultData, VaultKey, [u8; SALT_LEN])> {
    let path = vault_path(data_dir);
    if !path.is_file() {
        return Err(AppError::NoVault);
    }
    let bytes = fs::read(&path)?;
    let (params, nonce, body_at) = read_header(&bytes)?;
    let key = derive_key(password, &params)?;
    let mut plaintext = cipher(&key)?
        .decrypt(&XNonce::from(nonce), &bytes[body_at..])
        .map_err(|_| AppError::BadPassword)?;
    let data: VaultData = serde_json::from_slice(&plaintext).map_err(|_| AppError::CorruptVault)?;
    plaintext.zeroize();
    Ok((data, key, params.salt))
}

/// Re-encrypt the vault under a new password. A fresh salt is generated so the
/// new key is unrelated to the old one.
pub fn change_password(
    data_dir: &Path,
    old: &str,
    new: &str,
) -> Result<(VaultData, VaultKey, [u8; SALT_LEN])> {
    if new.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::WeakPassword);
    }
    let (data, _old_key, _old_salt) = unlock(data_dir, old)?;
    let salt: [u8; SALT_LEN] = random_bytes();
    let key = derive_key(
        new,
        &KdfParams {
            m_cost: M_COST,
            t_cost: T_COST,
            p_cost: P_COST,
            salt,
        },
    )?;
    save(data_dir, &data, &key, salt)?;
    Ok((data, key, salt))
}

/// Copy the still-encrypted vault somewhere the user chooses, for backup.
pub fn export(data_dir: &Path, dest: &Path) -> Result<()> {
    let src = vault_path(data_dir);
    if !src.is_file() {
        return Err(AppError::NoVault);
    }
    fs::copy(&src, dest)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("localwallet-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wallet(label: &str, byte: u8) -> StoredWallet {
        StoredWallet {
            label: label.to_string(),
            pubkey: format!("pk-{label}"),
            secret: [byte; 64],
            added_at: 0,
        }
    }

    #[test]
    fn round_trip_and_wrong_password() {
        let dir = tmp_dir("roundtrip");
        let (mut data, key, salt) = create(&dir, "correct horse").unwrap();
        data.wallets.push(wallet("one", 7));
        save(&dir, &data, &key, salt).unwrap();

        let (loaded, _, _) = unlock(&dir, "correct horse").unwrap();
        assert_eq!(loaded.wallets.len(), 1);
        assert_eq!(loaded.wallets[0].label, "one");
        assert_eq!(loaded.wallets[0].secret, [7u8; 64]);

        match unlock(&dir, "wrong password") {
            Err(AppError::BadPassword) => {}
            other => panic!("expected BadPassword, got {other:?}", other = other.err()),
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_refuses_to_clobber() {
        let dir = tmp_dir("clobber");
        create(&dir, "password1").unwrap();
        assert!(matches!(
            create(&dir, "password2"),
            Err(AppError::VaultExists)
        ));
        // the original password still works, i.e. nothing was overwritten
        assert!(unlock(&dir, "password1").is_ok());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn change_password_keeps_data_and_invalidates_old() {
        let dir = tmp_dir("changepw");
        let (mut data, key, salt) = create(&dir, "old password").unwrap();
        data.wallets.push(wallet("keeper", 3));
        save(&dir, &data, &key, salt).unwrap();

        change_password(&dir, "old password", "new password").unwrap();

        let (loaded, _, _) = unlock(&dir, "new password").unwrap();
        assert_eq!(loaded.wallets.len(), 1);
        assert_eq!(loaded.wallets[0].secret, [3u8; 64]);
        assert!(matches!(
            unlock(&dir, "old password"),
            Err(AppError::BadPassword)
        ));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_short_password() {
        let dir = tmp_dir("shortpw");
        assert!(matches!(create(&dir, "short"), Err(AppError::WeakPassword)));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn vault_file_contains_no_plaintext_key_material() {
        let dir = tmp_dir("noplaintext");
        let (mut data, key, salt) = create(&dir, "password123").unwrap();
        let secret = [0xABu8; 64];
        data.wallets.push(StoredWallet {
            label: "sensitive-label".into(),
            pubkey: "SoMePubKey".into(),
            secret,
            added_at: 0,
        });
        save(&dir, &data, &key, salt).unwrap();

        let raw = fs::read(vault_path(&dir)).unwrap();
        let b58 = bs58::encode(secret).into_string();
        assert!(!raw.windows(secret.len()).any(|w| w == secret));
        assert!(!contains(&raw, b58.as_bytes()));
        assert!(!contains(&raw, b"sensitive-label"));
        assert!(!contains(&raw, b"SoMePubKey"));
        fs::remove_dir_all(&dir).unwrap();
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn detects_corrupt_file() {
        let dir = tmp_dir("corrupt");
        create(&dir, "password123").unwrap();
        fs::write(vault_path(&dir), b"not a vault").unwrap();
        assert!(matches!(
            unlock(&dir, "password123"),
            Err(AppError::CorruptVault)
        ));
        fs::remove_dir_all(&dir).unwrap();
    }
}
