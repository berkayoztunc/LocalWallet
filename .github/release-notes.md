## Install

### macOS (Apple Silicon)

Download the `.dmg`, open it, and drag **LocalWallet** to Applications.

The app is ad-hoc signed but **not signed with an Apple Developer ID**, so macOS
will refuse to open it the first time, saying it cannot check it for malicious
software. Either:

- double-click it, dismiss the warning, then go to **System Settings → Privacy &
  Security** and click **Open Anyway**; or
- run `xattr -dr com.apple.quarantine /Applications/LocalWallet.app`

On macOS 15 and later, right-clicking → *Open* no longer works — Apple removed
that bypass.

### Windows (x64)

Download the `.exe` setup and run it. It is signed with a certificate from
[SignPath Foundation](https://signpath.org), which the UAC prompt should name as
the publisher.

SmartScreen builds reputation per certificate over time, so a new release may
still show *Windows protected your PC*. If it does, check the publisher in the
UAC prompt first, then **More info → Run anyway**.

Windows tray icons cannot carry text, so the SOL total shows on hover rather
than beside the icon.

### Linux (x64)

- **AppImage** — `chmod +x LocalWallet_*.AppImage`, then run it.
- **`.deb`** — `sudo apt install ./LocalWallet_*.deb` on Debian or Ubuntu.

Both are GPG-signed. To check a download before installing it:

```bash
gpg --verify SHA256SUMS.asc SHA256SUMS      # the checksum list is genuine
sha256sum --ignore-missing -c SHA256SUMS    # your file matches it
```

The key fingerprint is published in the README. The AppImage carries an embedded
signature too, but AppImage does not verify it when running — the detached
signature above is the one that counts.

The tray needs a desktop with AppIndicator support. GNOME has none out of the
box — install the *AppIndicator and KStatusNotifierItem Support* extension. On a
desktop with no tray, closing the window quits the app rather than hiding it to
an icon that is not there.

---

Your vault stays put across reinstalls:
`~/Library/Application Support/com.localwallet.app/` on macOS,
`~/.local/share/com.localwallet.app/` on Linux,
`%APPDATA%\com.localwallet.app\` on Windows.

See the commit history for what changed in this version.
