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
//! needed. The raw secret key does stay in this process.
//!
//! Two things get signed:
//!
//! * A fixed sign-in message, whose signature the SDK stretches into the key
//!   that encrypts the user's private notes. It is deterministic per wallet,
//!   which is what makes a shielded balance recoverable from the key alone.
//! * Deposit transactions, which move funds into the pool and so are signed by
//!   the depositing wallet like any other transfer.
//!
//! # What this does not protect
//!
//! Keeping the secret key in Rust does **not** keep spend authority over the
//! shielded balance out of the webview, and it is important not to read it that
//! way. The SDK derives the pool's spending key from the sign-in signature —
//! `utxoPrivateKeyV2 = keccak256(keccak256(signature))` — and that key is the
//! private witness of the withdrawal proof. Withdrawals carry no Solana
//! signature at all; the relayer submits them. So anyone holding the signature
//! returned by [`sign_in`] can move that wallet's shielded balance to any
//! address, offline, without the vault password, and locking the vault or
//! changing the password does not revoke it.
//!
//! That exposure is inherent to running the prover in the webview: it needs the
//! key. It cannot be argued away, only bounded. What bounds it lives in
//! `commands.rs` and `state.rs`, not here: `privacy_authorize` gates every call
//! into this module behind a native confirmation naming the wallet, and
//! `AppState`'s `PrivacyGrant` limits what that confirmation buys to one
//! wallet, one sign-in, and fifteen minutes, cleared the moment the vault
//! locks. This module still has to trust that gate rather than enforce it
//! itself — `sign_in` and `sign_deposit` take a `SigningKey` the caller has
//! already resolved, the same as every other signing function in this
//! codebase — so read `commands::privacy_authorize` alongside this file, not
//! instead of it.

use solana_sdk::message::VersionedMessage;
use solana_sdk::pubkey;
use solana_sdk::pubkey::Pubkey;
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
///
/// Note what that restriction does and does not buy. It stops this being a
/// general oracle; it does not make the return value safe. The one message it
/// will sign is exactly the message whose signature is the pool spending key,
/// so the caller receives spend authority over the shielded balance — see the
/// module docs.
pub fn sign_in(key: &SigningKey, message: &[u8]) -> Result<Vec<u8>> {
    if message != SIGN_IN_MESSAGE.as_bytes() {
        return Err(AppError::invalid(
            "refusing to sign an unrecognized message",
        ));
    }
    let keypair = key.keypair()?;
    Ok(keypair.sign_message(message).as_ref().to_vec())
}

/// The Privacy Cash program, and the lookup table its deposits resolve
/// accounts through. Both are pinned: the SDK lets environment variables
/// override them, and a build that quietly signed for a different program
/// would defeat the point of validating at all.
const PRIVACY_PROGRAM: Pubkey = pubkey!("9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD");
const PRIVACY_ALT: Pubkey = pubkey!("HEN49U2ySJ85Vc78qprSW9y6mFDhs1NczRxyppNHjofe");
/// The only other program a deposit may invoke.
const COMPUTE_BUDGET: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");

/// Anchor discriminator for the pool's `transact` instruction.
const TRANSACT_DISCRIMINATOR: [u8; 8] = [217, 149, 130, 143, 221, 52, 252, 119];

/// Offsets into the `transact` instruction data. The layout is fixed-width up
/// to this point (proof, root, hashes, nullifiers, commitments), so the two
/// numbers that decide where the money goes can be read without reimplementing
/// the SDK's serialization.
const EXT_AMOUNT: std::ops::Range<usize> = 488..496;
const FEE: std::ops::Range<usize> = 496..504;

/// Sign a Privacy Cash deposit of exactly `expected_lamports`.
///
/// The transaction is signed in place rather than rebuilt, so the message the
/// signature covers is exactly the one that was checked — a rebuild could
/// silently change it between validation and signing.
///
/// Everything before that is about refusing to be a general signing oracle.
/// The webview is untrusted, so "this names the wallet as a signer" is not a
/// sufficient reason to sign: that would equally describe a token `Approve`
/// granting a permanent delegate, a stake `Authorize`, or a transfer of every
/// NFT the wallet holds. Only the shape the SDK actually produces for a deposit
/// is accepted, and the amount must match what the user confirmed.
pub fn sign_deposit(key: &SigningKey, tx_bytes: &[u8], expected_lamports: u64) -> Result<Vec<u8>> {
    let mut tx: VersionedTransaction = bincode::deserialize(tx_bytes)
        .map_err(|e| AppError::invalid(format!("not a valid transaction: {e}")))?;

    let keypair = key.keypair()?;
    let pubkey = keypair.pubkey();

    // v0 only. The SDK always compiles to v0, and legacy messages cannot carry
    // the lookup table a real deposit depends on.
    let VersionedMessage::V0(message) = &tx.message else {
        return Err(AppError::invalid("only v0 deposit transactions are signed"));
    };

    if message.header.num_required_signatures != 1 {
        return Err(AppError::invalid(
            "a deposit is signed by the depositing wallet alone",
        ));
    }
    if message.account_keys.first() != Some(&pubkey) {
        return Err(AppError::invalid(
            "this wallet must be the fee payer of its own deposit",
        ));
    }
    // Accounts resolved through a lookup table cannot be checked without
    // fetching it, so the table itself is pinned instead.
    if message
        .address_table_lookups
        .iter()
        .any(|lookup| lookup.account_key != PRIVACY_ALT)
    {
        return Err(AppError::invalid(
            "deposit uses an unexpected address lookup table",
        ));
    }

    // Two instructions when the SDK drops its compute-unit price to fit the
    // 1232-byte limit, three otherwise.
    if !(2..=3).contains(&message.instructions.len()) {
        return Err(AppError::invalid(
            "unexpected instruction count for a deposit",
        ));
    }

    let mut deposits = 0usize;
    for instruction in &message.instructions {
        // An index past the static keys means the program came from the lookup
        // table, which no legitimate deposit does — and which would let an
        // arbitrary program in unchecked.
        let program = message
            .account_keys
            .get(instruction.program_id_index as usize)
            .ok_or_else(|| AppError::invalid("deposit invokes a program it does not name"))?;

        // Note this also rejects durable nonces: `AdvanceNonceAccount` is a
        // System Program instruction, so a transaction that never expires
        // cannot be built without adding System here. Do not add it.
        if *program == COMPUTE_BUDGET {
            continue;
        }
        if *program != PRIVACY_PROGRAM {
            return Err(AppError::invalid(
                "deposit invokes a program other than Privacy Cash",
            ));
        }

        deposits += 1;
        let data = &instruction.data;
        if data.len() < FEE.end || data[..8] != TRANSACT_DISCRIMINATOR {
            return Err(AppError::invalid("not a Privacy Cash deposit instruction"));
        }

        let fee = u64::from_le_bytes(data[FEE].try_into().expect("checked length"));
        if fee != 0 {
            return Err(AppError::invalid("a deposit does not pay a pool fee"));
        }

        // Negative means value leaving the pool, i.e. a withdrawal — which is
        // never signed here.
        let amount = i64::from_le_bytes(data[EXT_AMOUNT].try_into().expect("checked length"));
        let amount = u64::try_from(amount)
            .map_err(|_| AppError::invalid("deposit amount is not positive"))?;
        if amount != expected_lamports {
            return Err(AppError::invalid(format!(
                "deposit is for {amount} lamports, but {expected_lamports} was confirmed"
            )));
        }
    }

    if deposits != 1 {
        return Err(AppError::invalid(
            "a deposit carries exactly one Privacy Cash instruction",
        ));
    }

    if tx.signatures.is_empty() {
        tx.signatures.push(Signature::default());
    }
    tx.signatures[0] = keypair.sign_message(&tx.message.serialize());

    bincode::serialize(&tx)
        .map_err(|e| AppError::invalid(format!("could not re-encode transaction: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::instruction::{AccountMeta, Instruction};
    use solana_sdk::message::{v0, AddressLookupTableAccount, Message, VersionedMessage};
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

    const LAMPORTS: u64 = 20_000_000;

    /// Instruction data shaped like the SDK's `transact` payload: fixed-width
    /// up to the two fields this module reads, then the amount and the fee.
    fn transact_data(discriminator: [u8; 8], amount: i64, fee: u64) -> Vec<u8> {
        let mut data = vec![0u8; FEE.end];
        data[..8].copy_from_slice(&discriminator);
        data[EXT_AMOUNT].copy_from_slice(&amount.to_le_bytes());
        data[FEE].copy_from_slice(&fee.to_le_bytes());
        data
    }

    /// A pool account that lives in the lookup table rather than in the static
    /// keys, so compiling actually emits an `address_table_lookups` entry —
    /// without one, the lookup-table check would never be exercised.
    fn pooled_account() -> Pubkey {
        Pubkey::new_from_array([7; 32])
    }

    fn instruction(program: Pubkey, payer: &Pubkey, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(*payer, true),
                AccountMeta::new(pooled_account(), false),
            ],
            data,
        }
    }

    /// A deposit as `deposit.js` builds one: a compute-budget instruction, then
    /// the pool's `transact`, compiled to v0 against the pinned lookup table.
    fn deposit_tx(
        payer: &Pubkey,
        instructions: &[Instruction],
        alt: Pubkey,
    ) -> VersionedTransaction {
        let lookup = AddressLookupTableAccount {
            key: alt,
            addresses: vec![pooled_account()],
        };
        let message = v0::Message::try_compile(payer, instructions, &[lookup], Default::default())
            .expect("compile");
        VersionedTransaction {
            signatures: vec![Signature::default()],
            message: VersionedMessage::V0(message),
        }
    }

    fn compute_budget_ix(payer: &Pubkey) -> Instruction {
        instruction(COMPUTE_BUDGET, payer, vec![2, 0, 0, 0, 0])
    }

    fn valid_deposit(payer: &Pubkey) -> VersionedTransaction {
        deposit_tx(
            payer,
            &[
                compute_budget_ix(payer),
                instruction(
                    PRIVACY_PROGRAM,
                    payer,
                    transact_data(TRANSACT_DISCRIMINATOR, LAMPORTS as i64, 0),
                ),
            ],
            PRIVACY_ALT,
        )
    }

    fn sign(key: &SigningKey, tx: &VersionedTransaction) -> Result<Vec<u8>> {
        sign_deposit(key, &bincode::serialize(tx).expect("encode"), LAMPORTS)
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
    fn a_real_deposit_is_signed() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);
        let tx = valid_deposit(&keypair.pubkey());

        let signed_bytes = sign(&key, &tx).expect("sign");
        let signed: VersionedTransaction = bincode::deserialize(&signed_bytes).expect("decode");

        assert_eq!(signed.message, tx.message, "message must not be rewritten");
        assert!(signed.verify_with_results().into_iter().all(|ok| ok));
    }

    /// The oversize path in the SDK drops the compute-unit price instruction.
    #[test]
    fn a_two_instruction_deposit_is_signed() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);
        let payer = keypair.pubkey();
        let tx = deposit_tx(
            &payer,
            &[
                compute_budget_ix(&payer),
                instruction(
                    PRIVACY_PROGRAM,
                    &payer,
                    transact_data(TRANSACT_DISCRIMINATOR, LAMPORTS as i64, 0),
                ),
            ],
            PRIVACY_ALT,
        );
        assert!(sign(&key, &tx).is_ok());
    }

    /// The whole point: a transaction that names the wallet as a signer is not
    /// thereby a deposit. This one is a plain SOL transfer.
    #[test]
    fn another_program_is_refused() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);
        let payer = keypair.pubkey();
        let tx = deposit_tx(
            &payer,
            &[system_instruction::transfer(
                &payer,
                &Pubkey::new_unique(),
                1_000,
            )],
            PRIVACY_ALT,
        );
        assert!(sign(&key, &tx).is_err());
    }

    #[test]
    fn a_different_instruction_on_the_pool_is_refused() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);
        let payer = keypair.pubkey();
        let tx = deposit_tx(
            &payer,
            &[
                compute_budget_ix(&payer),
                instruction(
                    PRIVACY_PROGRAM,
                    &payer,
                    transact_data([9; 8], LAMPORTS as i64, 0),
                ),
            ],
            PRIVACY_ALT,
        );
        assert!(sign(&key, &tx).is_err());
    }

    #[test]
    fn an_amount_the_user_did_not_confirm_is_refused() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);
        let payer = keypair.pubkey();
        let tx = deposit_tx(
            &payer,
            &[
                compute_budget_ix(&payer),
                instruction(
                    PRIVACY_PROGRAM,
                    &payer,
                    transact_data(TRANSACT_DISCRIMINATOR, (LAMPORTS * 50) as i64, 0),
                ),
            ],
            PRIVACY_ALT,
        );
        assert!(sign(&key, &tx).is_err());
    }

    /// A negative `extAmount` is value leaving the pool, never a deposit.
    #[test]
    fn a_withdrawal_shaped_amount_is_refused() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);
        let payer = keypair.pubkey();
        let tx = deposit_tx(
            &payer,
            &[
                compute_budget_ix(&payer),
                instruction(
                    PRIVACY_PROGRAM,
                    &payer,
                    transact_data(TRANSACT_DISCRIMINATOR, -(LAMPORTS as i64), 0),
                ),
            ],
            PRIVACY_ALT,
        );
        assert!(sign(&key, &tx).is_err());
    }

    #[test]
    fn a_nonzero_pool_fee_is_refused() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);
        let payer = keypair.pubkey();
        let tx = deposit_tx(
            &payer,
            &[
                compute_budget_ix(&payer),
                instruction(
                    PRIVACY_PROGRAM,
                    &payer,
                    transact_data(TRANSACT_DISCRIMINATOR, LAMPORTS as i64, 1),
                ),
            ],
            PRIVACY_ALT,
        );
        assert!(sign(&key, &tx).is_err());
    }

    /// A well-formed deposit with something else smuggled alongside it.
    #[test]
    fn an_extra_instruction_is_refused() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);
        let payer = keypair.pubkey();
        let tx = deposit_tx(
            &payer,
            &[
                compute_budget_ix(&payer),
                compute_budget_ix(&payer),
                instruction(
                    PRIVACY_PROGRAM,
                    &payer,
                    transact_data(TRANSACT_DISCRIMINATOR, LAMPORTS as i64, 0),
                ),
                system_instruction::transfer(&payer, &Pubkey::new_unique(), 1_000),
            ],
            PRIVACY_ALT,
        );
        assert!(sign(&key, &tx).is_err());
    }

    #[test]
    fn an_unexpected_lookup_table_is_refused() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);
        let payer = keypair.pubkey();
        let tx = deposit_tx(
            &payer,
            &[
                compute_budget_ix(&payer),
                instruction(
                    PRIVACY_PROGRAM,
                    &payer,
                    transact_data(TRANSACT_DISCRIMINATOR, LAMPORTS as i64, 0),
                ),
            ],
            Pubkey::new_unique(),
        );
        assert!(sign(&key, &tx).is_err());
    }

    #[test]
    fn a_legacy_transaction_is_refused() {
        let keypair = Keypair::new();
        let key = signing_key(&keypair);
        let payer = keypair.pubkey();
        let tx = VersionedTransaction {
            signatures: vec![Signature::default()],
            message: VersionedMessage::Legacy(Message::new(
                &[instruction(
                    PRIVACY_PROGRAM,
                    &payer,
                    transact_data(TRANSACT_DISCRIMINATOR, LAMPORTS as i64, 0),
                )],
                Some(&payer),
            )),
        };
        assert!(sign(&key, &tx).is_err());
    }

    #[test]
    fn a_deposit_from_another_wallet_is_refused() {
        let keypair = Keypair::new();
        let stranger = Keypair::new();
        let key = signing_key(&keypair);
        let tx = valid_deposit(&stranger.pubkey());

        assert!(sign(&key, &tx).is_err());
    }
}
