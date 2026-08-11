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

The app makes requests to two hosts:

1. **The RPC endpoint you configure** — all chain reads and every transaction.
2. **`api.stakewiz.com`** — validator names, icons and APY estimates for the Stake screen, when the "Look up validator names" setting is on (it is on by default). Cached for six hours.
3. **`api.coingecko.com`** — the SOL price for the menu bar total, when the menu bar is on (it is on by default). Cached for one minute.

Neither third-party request carries an address, a balance or a key. Each discloses your IP and that someone running LocalWallet asked for public market or validator data. Both can be turned off in Settings, after which the app contacts nothing but your RPC.

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
- **The validator directory** — anything that lets its response influence a transaction, an amount, or an address the app acts on

## Out of scope

- An attacker who already has your master password, or code execution on your unlocked machine
- Phishing, or a maliciously modified build distributed by someone other than this repository's releases
- RPC provider behaviour, downtime, or rate limiting
- Rent that cannot be reclaimed because a token's creator holds the close authority — that is how SPL Token works, not a bug here
- Loss of funds from confirming an action the app described accurately

## What this project does not claim

**LocalWallet is unaudited.** No third party has reviewed the cryptography or the transaction logic. There is no bug bounty. It is offered under the MIT licence, without warranty — read the [LICENSE](LICENSE).

Use it for wallets you own, test on devnet, and keep an encrypted backup of your vault alongside the password. There is no recovery mechanism, by design.
