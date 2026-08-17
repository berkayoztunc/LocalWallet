# Security Policy

LocalWallet holds private keys. If you find something wrong with how it does that, I want to know before anyone else does.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting: **[Report a vulnerability](https://github.com/berkayoztunc/LocalWallet/security/advisories/new)** on the Security tab. That opens a private thread visible only to maintainers.

Helpful to include:

- what an attacker can achieve, and what access they need to do it
- steps to reproduce, ideally against devnet
- the app version and macOS version
- a suggested fix, if you have one

I'll acknowledge within a few days. Since this is a small project, fixes ship as a new tagged release, and the advisory is published once users have had a chance to update.

## Network access

The app makes requests to these hosts:

1. **The RPC endpoint you configure** — all chain reads and every transaction.
2. **`api.stakewiz.com`** — validator names, icons and APY estimates for the Stake screen, when the "Look up validator names" setting is on (it is on by default). Cached for six hours.
3. **`api.coingecko.com`** — the SOL price for the menu bar total, when the menu bar is on (it is on by default). Cached for one minute.
4. **`api3.privacycash.org`** — Privacy Cash's relayer, contacted only once you open the private-send dialog. Unlike the others, this one necessarily carries meaningful data: encrypted pool notes, zero-knowledge proofs, and the recipient address of a withdrawal. It is off until you use the feature, which is gated behind a one-time warning.

The directory and price requests carry no address, balance or key. Each discloses your IP and that someone running LocalWallet asked for public market or validator data. All three can be avoided in Settings or by not using the feature, after which the app contacts nothing but your RPC.

## Private sends

Privacy Cash's proving code is JavaScript and WASM, so it runs in the webview. Its own high-level client takes the raw secret key; that path is deliberately unused. The integration drives the SDK's external-signer entry points, and the backend exposes exactly two signing commands to the interface:

- `privacy_sign_in` signs one fixed message and compares the requested bytes against it before signing. Anything else is refused.
- `privacy_sign_transaction` signs a transaction only if it already names the wallet among its required signers, and signs in place without rewriting the message.

Neither returns the raw secret key. But an earlier version of this section implied that settled the matter, and it does not — the correction matters more than the original claim:

**The shielded balance is not protected to the same standard as the rest of the wallet.** The signature `privacy_sign_in` returns is what Privacy Cash derives its pool spending key from, and a withdrawal is authorised by that key with no Solana signature at all — the relayer submits it. So the code running in the webview holds enough to move your shielded funds to any address. That is inherent to running the prover there; it needs the key. Locking the vault or changing your password does not revoke a copy that has already leaked.

Concretely: your ordinary SOL survives a malicious npm dependency, and funds in the pool do not. Two consequences we would rather state than have a user discover:

- Keep the shielded balance to an amount you would accept losing to a bad release of a third-party package.
- `privacy_sign_transaction` currently signs any transaction naming the wallet as a required signer, checking only the signer position — not the programs invoked, nor the amount. Constraining it to genuine deposits, and requiring explicit per-wallet authorisation before a sign-in signature is issued, are the next changes to this area.

The pool contract and the relayer are third-party code that LocalWallet has not audited. Bugs in them are out of scope here — report those to Privacy Cash — but anything in *this* app that mishandles keys, signs more than it should, or sends a transaction the UI did not describe is very much in scope.

## What the menu bar writes to disk

Enabling the menu bar writes your **last known total, in SOL and USD, to `menubar.json` in cleartext**. This exists so a number can be shown while the vault is locked, which is impossible otherwise — the wallet addresses needed to compute one are encrypted.

It is the only holdings information this app keeps outside the encrypted vault. Anything that can read your home directory, your backups, or a synced copy of them can read it, and the menu bar itself is visible to anyone who can see your screen. The file holds a total only: no addresses, no keys, no per-wallet detail. Turning the menu bar off in Settings deletes it.

Data from the directory is treated as untrusted decoration. Every figure the app reports about your funds — stake amounts, commission, delinquency — comes from your own RPC, never from the directory.

## In scope

- **Vault encryption** — key derivation, the AEAD construction, nonce handling, anything that weakens `vault.bin` against an attacker who has the file
- **Key handling** — key material reaching the webview, logs, error messages, swap, or crash dumps; failures to zeroize
- **Transaction construction** — a transaction that sends funds somewhere other than what the UI showed and the user confirmed
- **Confirmation bypass** — anything that lets a destructive action run without the preview and explicit confirmation it is supposed to require
- **Supply chain** — a dependency shipping something it shouldn't
- **Release integrity** — anything that could get an unsigned or third-party binary published as though it were signed by this project, or that weakens the checksum/signature chain a user is told to verify
- **The validator directory** — anything that lets its response influence a transaction, an amount, or an address the app acts on
- **The private-send signing proxy** — anything that widens what `privacy_sign_in` or `privacy_sign_transaction` will put a signature on

## Out of scope

- An attacker who already has your master password, or code execution on your unlocked machine
- Phishing, or a maliciously modified build distributed by someone other than this repository's releases
- RPC provider behaviour, downtime, or rate limiting
- Rent that cannot be reclaimed because a token's creator holds the close authority — that is how SPL Token works, not a bug here
- Loss of funds from confirming an action the app described accurately

## Verifying what you downloaded

Windows installers are Authenticode-signed with a [SignPath Foundation](https://signpath.org) certificate; Linux artifacts ship a GPG-signed `SHA256SUMS`. The README has the fingerprint and the commands. **macOS builds are not signed** — notarization requires a paid Apple Developer account this project does not have, so on macOS the only integrity check available is building from source.

Signing happens in GitHub Actions from a tagged commit, never on a maintainer's machine, and the private keys are held by SignPath's HSM and GitHub secrets rather than being exportable from a laptop.

## What this project does not claim

**LocalWallet is unaudited.** No third party has reviewed the cryptography or the transaction logic. There is no bug bounty. It is offered under the MIT licence, without warranty — read the [LICENSE](LICENSE).

Use it for wallets you own, test on devnet, and keep an encrypted backup of your vault alongside the password. There is no recovery mechanism, by design.
