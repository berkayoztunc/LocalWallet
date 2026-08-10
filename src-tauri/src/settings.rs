//! Non-sensitive app settings, stored as cleartext JSON next to the vault.
//! Nothing in here is secret: no key material, no password.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

pub const DEFAULT_RPC: &str = "https://api.mainnet-beta.solana.com";
pub const DEFAULT_EXPLORER: &str = "solana-explorer";

/// Explorers the UI can link to. Kept here so a hand-edited settings file
/// cannot produce dead links.
pub const EXPLORERS: [&str; 3] = ["solana-explorer", "solscan", "orb"];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub rpc_url: String,
    /// Where sweeps send SOL. Stored so it does not have to be retyped, but the
    /// UI still requires an explicit confirmation before every sweep.
    pub destination_pubkey: Option<String>,
    pub priority_fee_microlamports: u64,
    /// Maximum wallets processed in parallel. The public RPC rate-limits hard,
    /// so this stays low by default.
    pub concurrency: usize,
    /// "processed" | "confirmed" | "finalized"
    pub commitment: String,
    /// Minutes of inactivity before the vault locks itself. 0 disables.
    pub auto_lock_minutes: u64,
    /// Which block explorer address/tx/token links open. One of `EXPLORERS`.
    pub explorer: String,
    /// The wallet that lends transaction fees to empty wallets so they can
    /// close their own token accounts. Picked from the vault.
    pub funder_pubkey: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            rpc_url: DEFAULT_RPC.to_string(),
            destination_pubkey: None,
            priority_fee_microlamports: 1_000,
            concurrency: 8,
            commitment: "confirmed".to_string(),
            auto_lock_minutes: 15,
            explorer: DEFAULT_EXPLORER.to_string(),
            funder_pubkey: None,
        }
    }
}

impl Settings {
    /// Clamp anything a hand-edited settings file could get wrong.
    pub fn sanitized(mut self) -> Self {
        if self.rpc_url.trim().is_empty() {
            self.rpc_url = DEFAULT_RPC.to_string();
        }
        self.rpc_url = self.rpc_url.trim().to_string();
        self.concurrency = self.concurrency.clamp(1, 32);
        self.priority_fee_microlamports = self.priority_fee_microlamports.min(10_000_000);
        if !matches!(
            self.commitment.as_str(),
            "processed" | "confirmed" | "finalized"
        ) {
            self.commitment = "confirmed".to_string();
        }
        self.auto_lock_minutes = self.auto_lock_minutes.min(24 * 60);
        if !EXPLORERS.contains(&self.explorer.as_str()) {
            self.explorer = DEFAULT_EXPLORER.to_string();
        }
        self.funder_pubkey = self
            .funder_pubkey
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty());
        self
    }
}

fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

/// A missing or unreadable settings file falls back to defaults rather than
/// blocking startup - settings hold nothing that cannot be recreated.
pub fn load(data_dir: &Path) -> Settings {
    let path = settings_path(data_dir);
    std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .unwrap_or_default()
        .sanitized()
}

pub fn save(data_dir: &Path, settings: &Settings) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = settings_path(data_dir);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(settings)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_clamps_out_of_range_values() {
        let s = Settings {
            rpc_url: "  ".into(),
            concurrency: 500,
            commitment: "nonsense".into(),
            explorer: "not-an-explorer".into(),
            ..Default::default()
        }
        .sanitized();
        assert_eq!(s.rpc_url, DEFAULT_RPC);
        assert_eq!(s.concurrency, 32);
        assert_eq!(s.commitment, "confirmed");
        assert_eq!(s.explorer, DEFAULT_EXPLORER);
    }

    #[test]
    fn every_known_explorer_survives_sanitizing() {
        for id in EXPLORERS {
            let s = Settings {
                explorer: id.into(),
                ..Default::default()
            }
            .sanitized();
            assert_eq!(s.explorer, id);
        }
    }

    #[test]
    fn settings_written_before_the_explorer_field_still_load() {
        // #[serde(default)] means an older settings.json simply picks up the
        // default rather than failing to parse.
        let older = r#"{"rpc_url":"https://example.com","concurrency":4}"#;
        let parsed: Settings = serde_json::from_str(older).unwrap();
        assert_eq!(parsed.explorer, DEFAULT_EXPLORER);
        assert_eq!(parsed.concurrency, 4);
        assert_eq!(parsed.funder_pubkey, None);
    }

    #[test]
    fn a_blank_funder_is_stored_as_none() {
        let s = Settings {
            funder_pubkey: Some("   ".into()),
            ..Default::default()
        }
        .sanitized();
        assert_eq!(s.funder_pubkey, None);
    }

    #[test]
    fn missing_file_yields_defaults() {
        let dir = std::env::temp_dir().join("localwallet-settings-missing");
        let _ = std::fs::remove_dir_all(&dir);
        let s = load(&dir);
        assert_eq!(s.rpc_url, DEFAULT_RPC);
    }

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("localwallet-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Settings {
            rpc_url: "https://example.helius-rpc.com".into(),
            concurrency: 12,
            ..Default::default()
        };
        save(&dir, &s).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.rpc_url, "https://example.helius-rpc.com");
        assert_eq!(loaded.concurrency, 12);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
