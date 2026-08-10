<div align="center">

<img src="src/assets/logo-256.png" alt="LocalWallet" width="120" height="120">

# LocalWallet

**Manage hundreds of Solana wallets from one desktop app.**
Encrypted locally. Keys never leave your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-01EEC5.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/berkayoztunc/LocalWallet?include_prereleases&color=01EEC5)](https://github.com/berkayoztunc/LocalWallet/releases)
[![CI](https://github.com/berkayoztunc/LocalWallet/actions/workflows/ci.yml/badge.svg)](https://github.com/berkayoztunc/LocalWallet/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/macOS-Apple%20Silicon-01EEC5)](https://github.com/berkayoztunc/LocalWallet/releases)

</div>

---

## The problem

You have 200 Solana wallets. Phantom shows you one at a time. Checking every balance means 200 imports, sweeping them means 200 manual transfers, and the rent locked in their unused token accounts — about **0.002 SOL each** — quietly stays there because it isn't worth the clicks.

Worse, once a wallet is empty it can't pay the fee to release its own rent. The SOL is stranded behind a chicken-and-egg problem.

LocalWallet does all of it in bulk, from one window, without your keys touching a server.

## Features

| | |
|---|---|
| **Encrypted vault** | Argon2id + XChaCha20-Poly1305. One master password, set on first run. |
| **Bulk balances** | Every wallet's SOL in two RPC calls, not two hundred. |
| **Token inventory** | Every token account across SPL Token and Token-2022, with balances, and how much rent is reclaimable. |
| **Close unused accounts** | Reclaim rent from zero-balance token accounts. Built and signed locally — no third-party service, no fee taken. |
| **Fund → close → return** | Lend an empty wallet a fee, close its accounts, send the proceeds on. Releases rent that would otherwise be unreachable. |
| **Collect all SOL** | Drain every wallet into one destination, with a per-wallet preview first. |
| **Send SOL** | Single transfers from any wallet, with a quote before you sign. |
| **Configurable** | Your own RPC endpoint, commitment level, priority fee, concurrency, and a choice of Solana Explorer, Solscan or Orb. |

## Security

Read this part.

- **Your keys never reach the interface.** All key material stays in Rust: decrypt → sign → zeroize. The UI only ever receives public keys, balances and signatures. No command in the app can return a private key.
- **The vault file leaks nothing.** Argon2id (64 MiB, 3 passes) derives the key; the whole wallet list is sealed with XChaCha20-Poly1305 under a fresh nonce on every save. Not the wallet count, not the labels — only the KDF parameters are readable, because they're needed to re-derive the key. A test asserts no plaintext key material appears in the file.
- **No password recovery.** A wrong password simply fails the AEAD check; no password hash is stored anywhere. Export a backup and keep the password somewhere safe.
- **No telemetry.** The only network traffic is to the RPC endpoint you configure.

> [!WARNING]
> **This is unaudited software that holds private keys.** It has not been reviewed by a third party. Use it for wallets you own, start on devnet, and try a single low-value wallet on mainnet before pointing it at everything you have. You are responsible for your own keys.

## Install

Download the latest `.dmg` from [**Releases**](https://github.com/berkayoztunc/LocalWallet/releases), open it, and drag **LocalWallet** to Applications.

macOS will refuse to open it the first time — the build is **not signed by an Apple Developer account**, so Gatekeeper treats it as untrusted. This is expected for open-source software distributed outside the App Store. Either:

- right-click the app → **Open** → **Open** again, or
- clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/LocalWallet.app
```

Apple Silicon only for now.

## Getting started

1. **Set a master password.** There is no recovery — the app makes you acknowledge that.
2. **Import your keys.** Paste them one per line, or many separated by commas. Both formats work and can be mixed:
   - base58 secret key (Phantom / Solflare export)
   - JSON byte array (`solana-keygen`, `id.json`)
3. **Set an RPC endpoint.** The public `api.mainnet-beta.solana.com` rate-limits hard at this scale. Use a dedicated provider (Helius, QuickNode, Triton), or a devnet URL to practise.
4. **Scan tokens** to see what rent is recoverable.
5. **Close accounts** — or **Fund & close** for wallets too empty to pay their own fee.
6. **Collect all SOL** into one destination. It shows a full preview and makes you retype the destination address before anything is signed.

## How it works

<details>
<summary><b>Why an empty wallet can't close its own token accounts</b></summary>

Closing a token account is a transaction, and transactions need a fee payer. A wallet swept to zero has nothing to pay with — even though the account it wants to close holds 0.00204 SOL that would land in that same wallet.

Two Solana rules make this sharper than it looks:

1. An account may not hold a **non-zero balance below the rent-exempt minimum** (890,880 lamports for a plain wallet). Funding an empty wallet with "just enough for fees" is rejected outright.
2. The runtime validates the fee payer on `balance − fee` **before instructions execute**. The rent the close is about to return doesn't count yet. So a wallet funded to *exactly* the minimum still can't pay for anything.

**Fund & close** handles both: it lends the rent-exempt minimum *plus* every fee the wallet will spend (~0.00095 SOL), closes the accounts, then drains the wallet to your destination. Three transactions, each waiting for the previous to confirm. The loan comes back with the rent.

</details>

<details>
<summary><b>Why some accounts can't be closed</b></summary>

`CloseAccount` validates the signer against `close_authority.unwrap_or(owner)`. When a token's creator sets a **close authority** pointing at themselves, only they can close it and claim the rent — your signature is rejected with `OwnerMismatch`.

Spam and airdrop tokens do this routinely. LocalWallet detects them during the scan, marks them **locked** in the UI, and excludes their rent from the reclaimable total rather than burning fees on transactions that cannot succeed. That rent is not recoverable by you, and no tool can change that.

</details>

<details>
<summary><b>Where your data lives</b></summary>

`~/Library/Application Support/com.localwallet.app/`

| File | Contents |
|---|---|
| `vault.bin` | Encrypted keypairs |
| `settings.json` | Cleartext, non-sensitive: RPC URL, destination, explorer, concurrency |

Reinstalling the app never touches this directory — the path is derived from the bundle identifier, not the app bundle.

</details>

## Build from source

Requires [Node.js](https://nodejs.org) (LTS), [Rust](https://rustup.rs), and Xcode Command Line Tools.

```bash
git clone https://github.com/berkayoztunc/LocalWallet.git
cd LocalWallet
npm install

npm run tauri dev      # hot-reloading dev build
npm run tauri build    # .app + .dmg in src-tauri/target/release/bundle/
cargo test --manifest-path src-tauri/Cargo.toml
```

## Roadmap

- [ ] Windows and Linux builds
- [ ] Signed and notarized macOS releases
- [ ] Auto-update
- [ ] SPL token sweeping (currently SOL only)
- [ ] Seed-phrase import and hardware wallet support

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For anything security-related, please read [SECURITY.md](SECURITY.md) first and report privately rather than opening a public issue.

## Licence

[MIT](LICENSE)
