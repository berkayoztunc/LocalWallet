# Contributing to LocalWallet

Thanks for taking a look. This is a small project with a narrow scope: managing many Solana wallets locally, safely.

> [!CAUTION]
> **Never develop or test against mainnet wallets holding real funds.** Use devnet. Point the app at `https://api.devnet.solana.com` in Settings and create throwaway keys with `solana-keygen new`. A mistake in this codebase moves money.

## Getting set up

You need [Node.js](https://nodejs.org) (LTS), [Rust](https://rustup.rs) (stable), and Xcode Command Line Tools.

```bash
git clone https://github.com/berkayoztunc/LocalWallet.git
cd LocalWallet
npm install
npm run tauri dev
```

The dev build uses the same vault as the installed app (`~/Library/Application Support/com.localwallet.app/`). If you'd rather not touch your real vault, change `identifier` in `src-tauri/tauri.conf.json` locally — but don't commit that change.

## Project layout

```
src-tauri/src/
├── main.rs             thin entry point
├── lib.rs              Tauri builder, command registration
├── commands.rs         the IPC surface — no command returns a private key
├── state.rs            unlocked vault, signing keys, zeroization
├── vault.rs            Argon2id + XChaCha20-Poly1305, atomic writes
├── keys.rs             private key import parsing
├── settings.rs         persisted, non-sensitive settings
├── rpc.rs              RPC client, batched balances, bounded concurrency
├── sweep.rs            SOL transfers: send, quote, bulk sweep
├── tokens.rs           token account scan, close, on-chain verification
└── funded_cleanup.rs   fund → close → return
src/
├── screens/            Setup, Unlock, Dashboard, Settings
├── components/         dialogs and the shared UI kit (ui.tsx)
└── lib/                typed IPC bindings (api.ts), explorer URLs
```

## Before you open a pull request

CI runs all of this, so run it locally first:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```

## Things that matter here

**Private keys stay in Rust.** Key material is decrypted, used to sign, and zeroized. It must never cross the IPC bridge into the webview, never be logged, and never appear in an error message. If a change makes a key reachable from `src/`, it will be rejected.

**Verify against the chain before signing.** The scan that produced a list may be minutes stale. Anything destructive — closing an account, draining a wallet — re-reads the authoritative state immediately before building the transaction. `tokens::verify_closable` is the pattern.

**Fail safe, not open.** When a value can't be read, assume the dangerous interpretation. An unparseable token balance is treated as *non-empty*, so an account holding tokens is never offered up for closing.

**Explain the non-obvious in comments.** Say why, not what. The rent-exemption arithmetic in `funded_cleanup.rs` and the close-authority check in `tokens.rs` both exist because of specific on-chain rules that are invisible from the code alone — those comments are the useful ones.

**Test the arithmetic.** Anything involving lamports, fees or rent gets a unit test with realistic values. Several bugs in this project's history were off-by-a-rent-exemption; the tests now pin them.

## Cutting a release

The version lives in `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml`, and CI refuses to build a release when a tag disagrees
with any of them. Set all three at once rather than editing them by hand:

```bash
npm run set-version 0.2.3
cargo check --manifest-path src-tauri/Cargo.toml   # refreshes Cargo.lock
git commit -am "Release v0.2.3"
git tag v0.2.3 && git push origin main --tags
```

The tag must be pushed on a commit that already contains the bump — that is
what the guard checks. The release is created as a draft for review.

## Reporting bugs

Include the app version (Settings → bottom of the page), your cluster, and the full error text. Errors from Solana carry the program logs — paste all of them; the failing instruction index is usually the answer.

For security issues, see [SECURITY.md](SECURITY.md) — please don't open a public issue.
