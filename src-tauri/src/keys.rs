//! Private key import. Accepts the two formats wallets actually export:
//! a base58 secret key (Phantom / Solflare) and a JSON byte array
//! (`solana-keygen` / `id.json`). Both 64-byte keypairs and bare 32-byte
//! seeds are accepted for each.

use serde::Serialize;
use solana_sdk::signature::Signer;
use solana_sdk::signer::keypair::Keypair;
use zeroize::Zeroize;

use crate::error::{AppError, Result};

/// Parse a single secret in either supported format and return the full
/// 64-byte keypair bytes plus the derived public key.
pub fn parse_secret(input: &str) -> Result<([u8; 64], String)> {
    let trimmed = input.trim().trim_end_matches(',');
    if trimmed.is_empty() {
        return Err(AppError::invalid("empty input"));
    }

    let mut bytes = if trimmed.starts_with('[') {
        let nums: Vec<u8> = serde_json::from_str(trimmed)
            .map_err(|_| AppError::invalid("not a valid JSON byte array"))?;
        nums
    } else {
        bs58::decode(trimmed)
            .into_vec()
            .map_err(|_| AppError::invalid("not valid base58 or a JSON byte array"))?
    };

    let keypair = match bytes.len() {
        64 => Keypair::try_from(bytes.as_slice())
            .map_err(|_| AppError::invalid("64 bytes given but not a valid ed25519 keypair"))?,
        32 => {
            let seed: [u8; 32] = bytes.as_slice().try_into().unwrap();
            Keypair::new_from_array(seed)
        }
        n => {
            bytes.zeroize();
            return Err(AppError::invalid(format!(
                "expected 32 or 64 bytes of key material, got {n}"
            )));
        }
    };
    bytes.zeroize();

    let pubkey = keypair.pubkey().to_string();
    let mut full = keypair.to_bytes();
    let out = full;
    full.zeroize();
    Ok((out, pubkey))
}

#[derive(Debug, Serialize)]
pub struct ImportLineError {
    pub line: usize,
    pub message: String,
    /// A short, non-secret hint so the user can find the offending line without
    /// the key itself being echoed back into the UI.
    pub preview: String,
}

/// Result of a bulk import. Successes and failures are reported together so a
/// single bad line never discards a 200-line paste.
#[derive(Debug, Default, Serialize)]
pub struct ImportReport {
    pub imported: usize,
    pub duplicates: usize,
    pub failed: Vec<ImportLineError>,
}

/// Split a bulk paste into candidate secrets. Lines are the primary separator;
/// commas also separate entries, but only outside `[...]` so JSON byte arrays
/// survive intact.
pub fn split_entries(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    for (idx, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let line_no = idx + 1;
        let mut depth = 0usize;
        let mut current = String::new();
        for ch in line.chars() {
            match ch {
                '[' => {
                    depth += 1;
                    current.push(ch);
                }
                ']' => {
                    depth = depth.saturating_sub(1);
                    current.push(ch);
                }
                ',' if depth == 0 => {
                    push_entry(&mut out, line_no, &mut current);
                }
                c if c.is_whitespace() && depth == 0 => {
                    push_entry(&mut out, line_no, &mut current);
                }
                _ => current.push(ch),
            }
        }
        push_entry(&mut out, line_no, &mut current);
    }
    out
}

fn push_entry(out: &mut Vec<(usize, String)>, line_no: usize, current: &mut String) {
    let entry = current.trim().to_string();
    current.clear();
    if !entry.is_empty() {
        out.push((line_no, entry));
    }
}

/// A masked preview of a rejected entry - enough to locate it, not enough to
/// leak a key that merely failed a length check.
pub fn mask(entry: &str) -> String {
    let chars: Vec<char> = entry.chars().collect();
    if chars.len() <= 8 {
        return "*".repeat(chars.len());
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}...{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_keypair() -> Keypair {
        Keypair::new_from_array([9u8; 32])
    }

    #[test]
    fn parses_base58_64_bytes() {
        let kp = sample_keypair();
        let b58 = bs58::encode(kp.to_bytes()).into_string();
        let (bytes, pubkey) = parse_secret(&b58).unwrap();
        assert_eq!(bytes, kp.to_bytes());
        assert_eq!(pubkey, kp.pubkey().to_string());
    }

    #[test]
    fn parses_json_byte_array() {
        let kp = sample_keypair();
        let json = serde_json::to_string(&kp.to_bytes().to_vec()).unwrap();
        let (bytes, pubkey) = parse_secret(&json).unwrap();
        assert_eq!(bytes, kp.to_bytes());
        assert_eq!(pubkey, kp.pubkey().to_string());
    }

    #[test]
    fn parses_32_byte_seed_in_both_formats() {
        let seed = [9u8; 32];
        let expected = sample_keypair().pubkey().to_string();

        let (_, from_b58) = parse_secret(&bs58::encode(seed).into_string()).unwrap();
        assert_eq!(from_b58, expected);

        let json = serde_json::to_string(&seed.to_vec()).unwrap();
        let (_, from_json) = parse_secret(&json).unwrap();
        assert_eq!(from_json, expected);
    }

    #[test]
    fn rejects_garbage_and_wrong_lengths() {
        assert!(parse_secret("").is_err());
        assert!(parse_secret("0OIl-not-base58").is_err());
        assert!(parse_secret("[1,2,3]").is_err());
        assert!(parse_secret(&bs58::encode([1u8; 40]).into_string()).is_err());
    }

    #[test]
    fn splits_bulk_paste_keeping_json_arrays_intact() {
        let kp = sample_keypair();
        let b58 = bs58::encode(kp.to_bytes()).into_string();
        let json = serde_json::to_string(&kp.to_bytes().to_vec()).unwrap();
        let text = format!("# comment\n{b58}\n\n{json}\n{b58},{b58}\n");

        let entries = split_entries(&text);
        assert_eq!(entries.len(), 4);
        for (_, entry) in &entries {
            assert!(parse_secret(entry).is_ok(), "failed to parse {entry}");
        }
    }

    #[test]
    fn splits_a_single_line_of_comma_separated_base58_keys() {
        // The common bulk-export shape: everything on one line, comma joined,
        // with stray spaces after the commas.
        let keys: Vec<String> = (1..=5)
            .map(|i| bs58::encode(Keypair::new_from_array([i as u8; 32]).to_bytes()).into_string())
            .collect();
        let text = keys.join(", ");

        let entries = split_entries(&text);
        assert_eq!(entries.len(), 5);
        for ((_, entry), expected) in entries.iter().zip(&keys) {
            assert_eq!(entry, expected);
            assert!(parse_secret(entry).is_ok());
        }
        // Everything came off one line, so every error would report line 1.
        assert!(entries.iter().all(|(line, _)| *line == 1));
    }

    #[test]
    fn trailing_comma_does_not_produce_an_empty_entry() {
        let b58 = bs58::encode(sample_keypair().to_bytes()).into_string();
        assert_eq!(split_entries(&format!("{b58},")).len(), 1);
        assert_eq!(split_entries(&format!("{b58},,\n,")).len(), 1);
    }

    #[test]
    fn mask_hides_the_middle() {
        assert_eq!(mask("abcdefghijkl"), "abcd...ijkl");
        assert_eq!(mask("abc"), "***");
    }
}
