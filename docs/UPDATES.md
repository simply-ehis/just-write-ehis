PURPOSE: one-time release setup + per-release self-update flow
OWNS: signing keys, endpoints, latest.json shape, release checklist
READ-WHEN: enabling updates, cutting a release, debugging update failures
KEY-FILES: src-tauri/tauri.conf.json (plugins.updater), src/lib/updates.ts, Settings → About → App Updates
INVARIANTS: signing cannot be disabled; UI reports "not configured" until setup is done; Android uses store tracks
GOTCHAS: private key via env only (.env files don't work); keep tauri.conf + Cargo versions in sync; private repo ⇒ private releases ⇒ updater 404s (see section above)
UPDATED: 2026-10-24

# UPDATES.md — App self-updates (Tauri updater)

> PURPOSE: one-time release setup + per-release flow for in-app updates.
> READ WHEN: enabling updates, cutting a release, debugging update failures.
> KEY FILES: `src-tauri/tauri.conf.json` (plugins.updater), `src-tauri/capabilities/default.json`, `src/lib/updates.ts`, `Settings → About → App Updates`.

The desktop app updates itself via the Tauri updater plugin. The flow is
Check (Settings → About, or silently on startup) → Download (progress bar)
→ Install → Relaunch. The browser preview never self-updates; it redeploys
with the site.

## One-time setup (maintainer)

1. **Signing keypair** — currently `3FF086625EED8646` (rotated 2026-09-29 with
   a fresh password). **The rotation completed with the v0.2.3 bridge
   release (2026-10-24)** — see "Rotating the signing key" below.
   The key that actually signed the published v0.2.1 installer is
   `1C2875FB2CC4040E` (verified from the release signature:
   `Just Write ehis_0.2.1_x64-setup.exe`, timestamp 2026-09-27 09:31 UTC) —
   *not* the key at the `v0.2.1` tag, which is `1C2ACD78E48FDD60`. The updater
   verifies each download against the pubkey compiled into the **running**
   binary, so every shipped install currently trusts `1C2875FB2CC4040E` and
   will **reject** anything signed with today's key. Until a bridge release
   ships, cutting a normal release silently bricks self-update for the entire
   installed base. See "Rotating the signing key" below.
   The private key lives at the repo root as `just-write-ehis.key`
   (gitignored, never commit it) and its password in
   `just-write-ehis.key.password` (also gitignored — back both up
   off-machine; losing them means existing installs can never update
   again). The public half is tracked as `just-write-ehis.key.pub` and
   must match `plugins.updater.pubkey` in `tauri.conf.json`. Builds MUST set both vars in-session
   (`TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)
   and MUST unset machine-level `TAURI_SIGNING_PRIVATE_KEY_PATH` (it points
   at another project's key and makes signing fail). Passwordless keys are
   avoided: the signer CLI prompts on the Windows console for them and
   hangs headless builds. (Superseded keys are backed up outside the repo —
   **keep `1C2875FB2CC4040E` until the bridge release below has shipped and
   the installed base has moved past it**; only then is it safe to delete.)
2. **Public key** — set in `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`. Matches the root key file.
3. **`plugins.updater.endpoints`** — set to the private repo's release
   feed (`simply-ehis/just-write-ehis/releases/latest/download/latest.json`).
   Two supported shapes:
   - Static `latest.json` on GitHub Releases (see format below), or
   - A dynamic server returning `204` (no update) or `200` + update JSON.
4. **Export the private key at build time** (PowerShell — `.env` files do
   NOT work). Deterministic path — dot-source the env script, then build
   in the same session (it sets the key + password vars from the repo
   root and clears the stale machine-level `TAURI_SIGNING_PRIVATE_KEY_PATH`):
   `. $HOME\.tauri\just-write-ehis-env.ps1`
   Gotcha: the `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` var must be present
   and correct — an absent/empty one makes tauri-cli stop for an
   interactive password prompt and hang headless builds forever.
   Gotcha (2026-10-24): the script hardcodes the old
   `C:\Users\ehis\source\repos\just-write-ehis\` path, which no longer
   exists (repo now lives under `Downloads`) — update the script's two
   paths, or set both vars inline from the repo-root key files as the
   0.2.3 build did.

## Rotating the signing key (bridge release)

The updater checks a download against the pubkey **baked into the binary that
is already running** — not against anything on disk or server-side. So a key
rotation is a two-release operation, and skipping the first half breaks every
install in the field.

To move from key `OLD` to key `NEW`:

1. **Bridge release.** Set `plugins.updater.pubkey` = `NEW`, then sign the
   build with `OLD`. Existing installs trust `OLD`, so they accept it; the
   binary they receive carries `NEW`, so from then on they trust `NEW`.
2. **Normal release.** Every release after the bridge is signed with `NEW`
   as usual.

Signing the bridge with `NEW` is the failure mode to avoid: the old install
base rejects it, and there is no in-app recovery — users must uninstall and
reinstall by hand.

Current state (as of 2026-10-24): the rotation is **complete**. `pubkey`
is `NEW` (`3FF086625EED8646`). v0.2.2 (2026-10-16) was mistakenly signed
with `NEW` instead of the bridge key, so v0.2.1 installs rejected that
update; the bridge then shipped as **v0.2.3 (2026-10-24)**, signed with
`OLD` (`1C2875FB2CC4040E`), letting every install in the field update and
carry `NEW` forward. Every release after v0.2.3 signs with
`3FF086625EED8646` (repo-root `just-write-ehis.key`) as usual. Keep the
`OLD` private key — `~/.tauri/just-write-ehis-superseded-2026-09-29.key`
plus its `.key.password` — until the installed base is known to be past
v0.2.3; only then is it safe to delete.

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

## Private repo? Read this first (2026-09-25)

GitHub Releases inherit repo visibility: a **private repo means private
releases**, and the Tauri updater fetches `latest.json` with no auth, so a
private-repo feed always 404s. Symptoms: Settings → About → Check for
Updates fails, and the app now reports "updates aren't available for this
build" instead of a raw fetch error (see `friendlyUpdateError` in
`src/lib/updates.ts`). The signing key and endpoint config are NOT the
problem — reachability is.

Options, cheapest first:

1. **Public static host for release artifacts (recommended).** Keep the
   code repo private; publish `latest.json` + signed installer artifacts
   to a public static host (Cloudflare Pages/R2 free tier). Point
   `plugins.updater.endpoints` there. Code stays private, updates work.
2. **GitHub with auth headers.** Tauri supports custom headers on the
   updater endpoint, but a token baked into a shipped app is readable by
   anyone — treat it as public anyway. Only for throwaway internal builds.
3. **No auto-update.** Leave the feed unpublished; installs update by
   downloading the new setup exe manually. The app's "not available"
   state covers this honestly.

Until one of the above is live, every install behaves as "updates
unavailable" — expected, not broken.

## Notes & limits

- Signing cannot be disabled — by design, unverified updates never install.
- `dialog: false` in config: all update UI is the app's own (Settings panel
  + startup banner), never a native popup.
- Android: use the Play Store track instead; the updater feed targets
  `windows` / `darwin` / `linux` (`{{target}}/{{arch}}` variables).
- Until steps 1–3 are done, Settings → About shows "not configured"
  (`app_update_status` command) instead of failing cryptically.
