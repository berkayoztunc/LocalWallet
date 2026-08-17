//! Signing proxy for the Privacy Cash shielded pool.
//!
//! Privacy Cash's zero-knowledge work — proof generation, note encryption,
//! Merkle proofs — only exists as a JavaScript/WASM SDK, so it has to run in
//! the webview. Its high-level client wants the raw secret key handed to it,
//! which this app will not do: keys live in the vault and are only ever
//! materialized inside this process.
//!
//! The SDK's lower-level entry points take an external signer instead, so the
//! webview drives the protocol and calls back here whenever a signature is
//! needed. Only bytes to sign go out; only signatures come back.
//!
//! Two things get signed:
//!
//! * A fixed sign-in message, whose signature the SDK stretches into the key
//!   that encrypts the user's private notes. It is deterministic per wallet,
//!   which is what makes a shielded balance recoverable from the key alone.
//! * Deposit transactions, which move funds into the pool and so are signed by
//!   the depositing wallet like any other transfer.
//!
//! Withdrawals are deliberately absent: the pool authorizes those with a zero
//! knowledge proof rather than a signature, which is precisely what unlinks
//! the recipient from the depositor.

use solana_sdk::signature::Signature;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::VersionedTransaction;

use crate::error::{AppError, Result};
use crate::state::SigningKey;

/// The message the SDK expects to be signed before it will derive an
/// encryption key. The exact bytes are protocol, not preference — changing
/// them would derive a different key and hide any balance already deposited.
pub const SIGN_IN_MESSAGE: &str = "Privacy Money account sign in";

/// Sign the sign-in message with `key`, returning the raw 64-byte signature.
///
/// Restricted to the one known message on purpose. A general "sign these
/// bytes" command reachable from the webview is an open-ended signing oracle,
/// and a Solana transaction is just bytes too.
pub fn sign_in(key: &SigningKey, message: &[u8]) -> Result<Vec<u8>> {
    if message != SIGN_IN_MESSAGE.as_bytes() {
        return Err(AppError::invalid(
            "refusing to sign an unrecognized message",
        ));
    }
    let keypair = key.keypair()?;
    Ok(keypair.sign_message(message).as_ref().to_vec())
}

/// Add `key`'s signature to an already-built deposit transaction.
///
/// `tx_bytes` is the wire format the webview produced. The transaction is
/// signed in place rather than rebuilt, so any signature the relayer has
/// already contributed survives.
pub fn sign_transaction(key: &SigningKey, tx_bytes: &[u8]) -> Result<Vec<u8>> {
    let mut tx: VersionedTransaction = bincode::deserialize(tx_bytes)
        .map_err(|e| AppError::invalid(format!("not a valid transaction: {e}")))?;

    let keypair = key.keypair()?;
    let pubkey = keypair.pubkey();

    // The signature has to land in the slot matching this key's position among
    // the required signers; anywhere else and the runtime rejects it.
    let position = tx
        .message
        .static_account_keys()
        .iter()
        .position(|k| *k == pubkey)
        .ok_or_else(|| {
            AppError::invalid("transaction does not name this wallet as a signer")
        })?;

    let required = tx.message.header().num_required_signatures as usize;
    if position >= required {
        return Err(AppError::invalid(
            "transaction does not require a signature from this wallet",
        ));
    }
    if tx.signatures.len() < required {
        tx.signatures.resize(required, Signature::default());
    }

    tx.signatures[position] = keypair.sign_message(&tx.message.serialize());

    bincode::serialize(&tx)
        .map_err(|e| AppError::invalid(format!("could not re-encode transaction: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::message::{v0, VersionedMessage};
    use solana_sdk::pubkey::Pubkey;
    use solana_sdk::signer::keypair::Keypair;
    use solana_system_interface::instruction as system_instruction;

    /// Build a `SigningKey` around a throwaway keypair, mirroring what the
    /// vault hands to the commands.
    fn signing_key(keypair: &Keypair) -> SigningKey {
        SigningKey::for_test(
            "test".to_string(),
            keypair.pubkey().to_string(),
            keypair.to_bytes(),
        )
    }

    fn unsigned_transfer(from: &Pubkey, to: &Pubkey) -> VersionedTransaction {
        let message = v0::Message::try_compile(
            from,
            &[system_instruction::transfer(from, to, 1_000)],
            &[],
            Default::default(),
        )
        .expect("compile");
        VersionedTransaction {
            signatures: vec![Signature::default()],
            message: VersionedMessage::V0(message),
        }
    }

    #[test]
    fn sign_in_rejects_anything_but_the_known_message() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);

        assert!(sign_in(&key, SIGN_IN_MESSAGE.as_bytes()).is_ok());
        assert!(sign_in(&key, b"approve this transfer").is_err());
    }

    #[test]
    fn sign_in_signature_verifies_and_is_deterministic() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);

        let first = sign_in(&key, SIGN_IN_MESSAGE.as_bytes()).expect("sign");
        let second = sign_in(&key, SIGN_IN_MESSAGE.as_bytes()).expect("sign");
        assert_eq!(first, second, "encryption key derivation depends on this");

        let signature = Signature::try_from(first.as_slice()).expect("64 bytes");
        assert!(signature.verify(keypair.pubkey().as_ref(), SIGN_IN_MESSAGE.as_bytes()));
    }

    #[test]
    fn sign_transaction_produces_a_verifiable_signature() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);
        let tx = unsigned_transfer(&keypair.pubkey(), &Pubkey::new_unique());

        let signed_bytes =
            sign_transaction(&key, &bincode::serialize(&tx).expect("encode")).expect("sign");
        let signed: VersionedTransaction = bincode::deserialize(&signed_bytes).expect("decode");

        assert_eq!(signed.message, tx.message, "message must not be rewritten");
        assert!(signed.verify_with_results().into_iter().all(|ok| ok));
    }

    #[test]
    fn sign_transaction_refuses_a_transaction_it_is_not_party_to() {
        let keypair = Keypair::new();
        let stranger = Keypair::new();
        let key = signing_key(&keypair);
        let tx = unsigned_transfer(&stranger.pubkey(), &Pubkey::new_unique());

        let result = sign_transaction(&key, &bincode::serialize(&tx).expect("encode"));
        assert!(result.is_err());
    }
}
