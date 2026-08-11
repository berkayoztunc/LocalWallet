//! The macOS menu bar total.
//!
//! Shows `163.4 SOL · $12,438` next to the tray icon, and keeps showing it
//! after the vault locks or the app restarts.
//!
//! That last part is a deliberate trade. The vault encrypts wallet addresses,
//! so a locked app cannot compute a balance — it can only display a number
//! saved earlier. Saving it means `menubar.json` reveals roughly what you
//! hold to anything that can read your disk, which nothing outside the
//! encrypted vault did before. It lives in its own file so it is obvious and
//! individually deletable, and the whole feature can be switched off, which
//! removes the file.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::error::{AppError, Result};

/// Reference SOL price. No API key, ~24 bytes back.
const PRICE_URL: &str =
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

/// The menu bar is glanceable, not a trading screen. One price a minute is
/// plenty and keeps well inside CoinGecko's free rate limit.
const PRICE_TTL: Duration = Duration::from_secs(60);

const LAMPORTS_PER_SOL: f64 = 1_000_000_000.0;

/// The tray's id, used to find it again when the total changes.
pub const TRAY_ID: &str = "main";

/// Menu item ids. Items are looked up through `Menu::get` and mutated in
/// place, so nothing needs to hold on to their handles.
pub const MENU_STATUS: &str = "status";
pub const MENU_SHOW: &str = "show";
pub const MENU_REFRESH: &str = "refresh";
pub const MENU_QUIT: &str = "quit";

pub const REFRESH_LABEL: &str = "Refresh balances";
/// Shown instead when the vault is locked: the wallet list is encrypted, so
/// there is nothing to refresh. Saying why beats a dead menu item.
pub const REFRESH_LOCKED_LABEL: &str = "Refresh balances — unlock first";

/// What the disabled status line at the top of the menu is reporting.
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    /// Nothing refreshed yet this session.
    Never,
    /// A refresh is in flight.
    Updating,
    /// Succeeded at this unix time.
    Updated(i64),
    /// Failed. Carries the previous success, if there was one.
    Failed {
        reason: String,
        last_success: Option<i64>,
    },
}

/// Render the status line.
///
/// Pure, so the wording is pinned by tests rather than discovered in a menu.
/// The failure case deliberately keeps the previous timestamp: a menu bar that
/// forgets when it was last right is worse than one that admits it is stale.
pub fn status_line(status: &Status) -> String {
    match status {
        Status::Never => "Not updated yet".to_string(),
        Status::Updating => "Updating…".to_string(),
        Status::Updated(at) => format!("Updated {}", clock(*at)),
        Status::Failed {
            reason,
            last_success,
        } => match last_success {
            Some(at) => format!("{reason} — last update {}", clock(*at)),
            None => reason.clone(),
        },
    }
}

/// Local wall-clock `HH:MM` for a unix timestamp. `chrono` is already in the
/// dependency tree, so this costs no extra build.
fn clock(unix: i64) -> String {
    chrono::DateTime::from_timestamp(unix, 0)
        .map(|utc| {
            chrono::DateTime::<chrono::Local>::from(utc)
                .format("%H:%M")
                .to_string()
        })
        .unwrap_or_else(|| "??:??".to_string())
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Cached {
    pub lamports: u64,
    /// Total in USD at the time it was written. `None` when the price was
    /// unavailable, so the title falls back to SOL only.
    pub usd: Option<f64>,
    pub updated_at: i64,
}

#[derive(Default)]
pub struct PriceCache {
    inner: AsyncMutex<Option<(f64, Instant)>>,
}

impl PriceCache {
    /// Current SOL price in USD, reusing a recent lookup.
    pub async fn get(&self) -> Result<f64> {
        let mut guard = self.inner.lock().await;
        if let Some((price, at)) = *guard {
            if at.elapsed() < PRICE_TTL {
                return Ok(price);
            }
        }

        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("LocalWallet/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| AppError::Rpc(e.to_string()))?
            .get(PRICE_URL)
            .send()
            .await
            .map_err(|e| AppError::Rpc(e.to_string()))?;

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::Rpc(e.to_string()))?;
        let price = body["solana"]["usd"]
            .as_f64()
            .ok_or_else(|| AppError::Rpc("price response had no solana.usd field".into()))?;

        *guard = Some((price, Instant::now()));
        Ok(price)
    }
}

/// Format the menu bar title.
///
/// Pure, so the awkward cases are unit tested rather than discovered in the
/// menu bar: a missing price must degrade to SOL alone rather than blanking,
/// and the string has to stay short enough that macOS does not truncate it.
pub fn format_title(lamports: u64, usd_price: Option<f64>) -> String {
    let sol = lamports as f64 / LAMPORTS_PER_SOL;

    // Precision tracks magnitude: small balances need decimals to say anything
    // at all, large ones would waste menu bar width on them.
    let sol_text = if sol >= 1000.0 {
        format!("{} SOL", thousands(sol.round() as u64))
    } else if sol >= 1.0 {
        format!("{sol:.2} SOL")
    } else if sol > 0.0 {
        format!("{sol:.4} SOL")
    } else {
        "0 SOL".to_string()
    };

    match usd_price {
        Some(price) if price > 0.0 => {
            let usd = sol * price;
            let usd_text = if usd >= 1000.0 {
                format!("${}", thousands(usd.round() as u64))
            } else {
                format!("${usd:.2}")
            };
            format!("{sol_text} · {usd_text}")
        }
        _ => sol_text,
    }
}

/// Group digits so a five-figure total is readable at a glance.
fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join("menubar.json")
}

/// The last known total. Missing or unreadable simply means "nothing to show
/// yet" — this file is a convenience, never a source of truth.
pub fn load(data_dir: &Path) -> Option<Cached> {
    std::fs::read(cache_path(data_dir))
        .ok()
        .and_then(|b| serde_json::from_slice::<Cached>(&b).ok())
}

/// Written temp-then-rename so a crash mid-write cannot leave a truncated file.
pub fn save(data_dir: &Path, cached: &Cached) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = cache_path(data_dir);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(cached)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Remove the cache. Called when the feature is switched off, so turning it
/// off actually takes the holdings information off disk rather than merely
/// hiding it.
pub fn clear(data_dir: &Path) {
    let _ = std::fs::remove_file(cache_path(data_dir));
}

/// Price the total, update the tray title, and persist it.
///
/// A price failure is not an error: the title falls back to SOL only. A wallet
/// app that blanks its menu bar because a price API hiccuped would be worse
/// than one showing less.
pub async fn refresh(data_dir: &Path, prices: &PriceCache, lamports: u64) -> (String, Cached) {
    let usd_price = prices.get().await.ok();
    let title = format_title(lamports, usd_price);
    let cached = Cached {
        lamports,
        usd: usd_price.map(|p| lamports as f64 / LAMPORTS_PER_SOL * p),
        updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default(),
    };
    let _ = save(data_dir, &cached);
    (title, cached)
}

/// The title to show at launch, before anything has been refreshed.
pub fn cached_title(data_dir: &Path) -> Option<String> {
    let cached = load(data_dir)?;
    // Re-derive the price from the stored USD total rather than calling out on
    // startup: the app should show something instantly, offline included.
    let price = cached
        .usd
        .filter(|_| cached.lamports > 0)
        .map(|usd| usd / (cached.lamports as f64 / LAMPORTS_PER_SOL));
    Some(format_title(cached.lamports, price))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;

    #[test]
    fn title_pairs_sol_with_usd() {
        // 163.4 SOL at $76 -> the shape the menu bar is designed around.
        assert_eq!(
            format_title(163_400_000_000, Some(76.13)), // 163.4 SOL
            "163.40 SOL · $12,440"
        );
    }

    #[test]
    fn a_missing_price_degrades_to_sol_rather_than_blanking() {
        // The whole point of the fallback: no network, still informative.
        assert_eq!(format_title(163_400_000_000, None), "163.40 SOL");
        assert_eq!(format_title(5 * SOL, Some(0.0)), "5.00 SOL");
    }

    #[test]
    fn precision_tracks_magnitude() {
        // Dust would read as "0.00 SOL" at two decimals, which is a lie.
        assert_eq!(format_title(12_300_000, None), "0.0123 SOL");
        // Large balances waste menu bar width on decimals.
        assert_eq!(format_title(12_345 * SOL, None), "12,345 SOL");
        assert_eq!(format_title(0, Some(76.0)), "0 SOL · $0.00");
    }

    #[test]
    fn thousands_groups_from_the_right() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_000), "1,000");
        assert_eq!(thousands(12_345), "12,345");
        assert_eq!(thousands(1_234_567), "1,234,567");
    }

    #[test]
    fn status_line_covers_every_state() {
        assert_eq!(status_line(&Status::Never), "Not updated yet");
        assert_eq!(status_line(&Status::Updating), "Updating…");
        // The clock text depends on the machine's timezone, so assert the
        // shape rather than a fixed hour.
        let updated = status_line(&Status::Updated(1_700_000_000));
        assert!(updated.starts_with("Updated "), "got {updated}");
        assert_eq!(updated.len(), "Updated 00:00".len());
    }

    #[test]
    fn a_failure_keeps_the_last_good_timestamp() {
        // A menu bar that forgets when it was last right is worse than one
        // that admits it is stale, so the previous success survives an error.
        let failed = status_line(&Status::Failed {
            reason: "RPC unreachable".into(),
            last_success: Some(1_700_000_000),
        });
        assert!(
            failed.starts_with("RPC unreachable — last update "),
            "got {failed}"
        );

        // With nothing to fall back on, the reason stands alone rather than
        // inventing a time.
        assert_eq!(
            status_line(&Status::Failed {
                reason: "RPC unreachable".into(),
                last_success: None,
            }),
            "RPC unreachable"
        );
    }

    #[test]
    fn cache_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("localwallet-menubar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        assert!(load(&dir).is_none(), "no file yet");

        let cached = Cached {
            lamports: 163_400_000_000,
            usd: Some(12_440.0),
            updated_at: 1_700_000_000,
        };
        save(&dir, &cached).unwrap();

        let loaded = load(&dir).expect("written cache should load");
        assert_eq!(loaded.lamports, cached.lamports);
        assert_eq!(loaded.usd, cached.usd);

        // The startup path reconstructs the same title without any network.
        assert_eq!(cached_title(&dir).unwrap(), "163.40 SOL · $12,440");

        // Turning the feature off must take the data off disk, not just hide it.
        clear(&dir);
        assert!(load(&dir).is_none(), "clear must delete the file");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
