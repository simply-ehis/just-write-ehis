PURPOSE: one-time release setup + per-release self-update flow
OWNS: signing keys, endpoints, latest.json shape, release checklist
READ-WHEN: enabling updates, cutting a release, debugging update failures
KEY-FILES: src-tauri/tauri.conf.json (plugins.updater), src/lib/updates.ts, Settings → About → App Updates
INVARIANTS: signing cannot be disabled; UI reports "not configured" until setup is done; Android uses store tracks
GOTCHAS: private key via env only (.env files don't work); keep tauri.conf + Cargo versions in sync
UPDATED: 2026-09-25

# UPDATES.md — App self-updates (Tauri updater)

> PURPOSE: one-time release setup + per-release flow for in-app updates.
> READ WHEN: enabling updates, cutting a release, debugging update failures.
> KEY FILES: `src-tauri/tauri.conf.json` (plugins.updater), `src-tauri/capabilities/default.json`, `src/lib/updates.ts`, `Settings → About → App Updates`.

The desktop app updates itself via the Tauri updater plugin. The flow is
Check (Settings → About, or silently on startup) → Download (progress bar)
→ Install → Relaunch. The browser preview never self-updates; it redeploys
with the site.

## One-time setup (maintainer)

1. **Signing keypair** — done. The private key lives at the repo root as
   `just-write-ehis.key` (gitignored, never commit it). Losing it means
   existing installs can never update again — back it up off-machine.
2. **Public key** — set in `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`. Matches the root key file.
3. **`plugins.updater.endpoints`** — set to the private repo's release
   feed (`simply-ehis/just-write-ehis/releases/latest/download/latest.json`).
   Two supported shapes:
   - Static `latest.json` on GitHub Releases (see format below), or
   - A dynamic server returning `204` (no update) or `200` + update JSON.
4. **Export the private key at build time** (PowerShell — `.env` files do
   NOT work):
   `$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw just-write-ehis.key`
   then run the build in the same session so the variable is visible.
   Gotcha 2026-09-18: if the key ever gains a password, the
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` var must be present and correct —
   an absent/empty one makes tauri-cli stop for an interactive password
   prompt and hang headless builds forever.

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
