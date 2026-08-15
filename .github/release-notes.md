## Install

### macOS (Apple Silicon)

Download the `.dmg`, open it, and drag **LocalWallet** to Applications.

This build is **not signed with an Apple Developer ID**, so macOS will refuse to
open it the first time. Either:

- double-click it, dismiss the warning, then go to **System Settings → Privacy &
  Security** and click **Open Anyway**; or
- run `xattr -dr com.apple.quarantine /Applications/LocalWallet.app`

On macOS 15 and later, right-clicking → *Open* no longer works — Apple removed
that bypass.

### Windows (x64)

Download the `.exe` setup and run it. The build is **not code-signed**, so
SmartScreen will warn you: click **More info → Run anyway**.

Windows tray icons cannot carry text, so the SOL total shows on hover rather
than beside the icon.

### Linux (x64)

- **AppImage** — `chmod +x LocalWallet_*.AppImage`, then run it.
- **`.deb`** — `sudo apt install ./LocalWallet_*.deb` on Debian or Ubuntu.

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
