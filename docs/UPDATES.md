PURPOSE: one-time release setup + per-release self-update flow
OWNS: signing keys, endpoints, latest.json shape, release checklist
READ-WHEN: enabling updates, cutting a release, debugging update failures
KEY-FILES: src-tauri/tauri.conf.json (plugins.updater), src/lib/updates.ts, Settings → About → App Updates
INVARIANTS: signing cannot be disabled; UI reports "not configured" until setup is done; Android uses store tracks
GOTCHAS: private key via env only (.env files don't work); keep tauri.conf + Cargo versions in sync
UPDATED: 2026-09-17

# UPDATES.md — App self-updates (Tauri updater)

> PURPOSE: one-time release setup + per-release flow for in-app updates.
> READ WHEN: enabling updates, cutting a release, debugging update failures.
> KEY FILES: `src-tauri/tauri.conf.json` (plugins.updater), `src-tauri/capabilities/default.json`, `src/lib/updates.ts`, `Settings → About → App Updates`.

The desktop app updates itself via the Tauri updater plugin. The flow is
Check (Settings → About, or silently on startup) → Download (progress bar)
→ Install → Relaunch. The browser preview never self-updates; it redeploys
with the site.

## One-time setup (maintainer)

1. **Generate the signing keypair** (private key stays secret forever —
   losing it means existing installs can never update again):
   `npm run tauri signer generate -- -w ~/.tauri/just-write-ehis.key`
2. **Paste the public key** into `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey` (replace `REPLACE_WITH_UPDATER_PUBLIC_KEY`).
3. **Point `plugins.updater.endpoints`** at your release feed (replace the
   `YOUR_USER/YOUR_REPO` placeholder). Two supported shapes:
   - Static `latest.json` on GitHub Releases (see format below), or
   - A dynamic server returning `204` (no update) or `200` + update JSON.
4. **Export the private key at build time** (PowerShell — `.env` files do
   NOT work). Most reliable: dot-source the helper (immune to stale
   session environments):
   `. $HOME\.tauri\just-write-ehis-env.ps1`
   (sets `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   from `~/.tauri/`; the password lives in `just-write-ehis.pw.txt` next
   to the key — back both up, losing them bricks future updates).
   Gotcha 2026-09-18: the PASSWORD var must be present and correct — an
   absent/empty one makes tauri-cli stop for an interactive password
   prompt and hang headless builds forever. Registry User env alone is
   NOT enough for shells spawned before it was set.

## Per-release flow

1. Bump `version` in **both** `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml` (they must match; the first `tauri build`
   refreshes `Cargo.lock` automatically).
2. Build: `npm run tauri build` (signs artifacts via the env key above;
   `createUpdaterArtifacts: true` emits `.sig` files).
3. Publish the artifacts + a `latest.json` to the endpoint:
   ```json
   {
     "version": "0.3.0",
     "notes": "What changed",
     "pub_date": "2026-09-16T00:00:00Z",
     "platforms": {
       "windows-x86_64": { "signature": "<contents of .sig file>", "url": "https://…/app-setup.exe" },
       "darwin-aarch64": { "signature": "<contents of .sig file>", "url": "https://…/app.tar.gz" },
       "linux-x86_64": { "signature": "<contents of .sig file>", "url": "https://…/app.AppImage" }
     }
   }
   ```
   (`tauri-action` on GitHub generates this file for you.)
4. Desktop installs pick the update up on next launch (or via
   Settings → About → Check for Updates). On Windows the app exits
   itself to let the installer run.

## Notes & limits

- Signing cannot be disabled — by design, unverified updates never install.
- `dialog: false` in config: all update UI is the app's own (Settings panel
  + startup banner), never a native popup.
- Android: use the Play Store track instead; the updater feed targets
  `windows` / `darwin` / `linux` (`{{target}}/{{arch}}` variables).
- Until steps 1–3 are done, Settings → About shows "not configured"
  (`app_update_status` command) instead of failing cryptically.
