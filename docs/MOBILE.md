PURPOSE: How Just Write ehis behaves on phones and what an Android build still needs
OWNS: mobile shell behavior, mobile CSS contract, Android native-shell recipe
READ-WHEN: adding a mobile feature, changing BottomBar/app.css mobile rules, or attempting an APK build
KEY-FILES: src/App.svelte (breakpoint + mobile sheets), src/app.css (mobile media queries), src/lib/components/BottomBar.svelte (phone nav), tests/mobile-parity.mjs (probe)
INVARIANTS: isMobile means viewport <= 768px; desktop CSS must not be altered by mobile rules except inside media queries; every phone control is >= 44px; hidden-workspace rules identical to desktop
GOTCHAS: jsdom applies no CSS, so mobile-parity asserts CSS by source contract and behavior by driving the real bundle; touch changes require (hover: none), (pointer: coarse)
UPDATED: 2026-09-25

# Mobile / Android

## What phones get today (no native shell required)

The app already adapts at `<= 768px` (`checkMobile()` in `src/App.svelte`, now also
following `visualViewport` so the soft keyboard cannot flip the breakpoint):

- Sidebar becomes an overlay drawer; `BottomBar` replaces the status bar; the status
  bar's save signal survives as the BottomBar `save-dot`.
- AI Panel renders as a bottom sheet; the Inspector is reachable from More → Outline and
  uses the same sheet + its own close button.
- Settings nav, Properties tables, and graph/editor toolbars collapse or scroll.
- Phone-specific contract (all in `src/app.css` / component styles):
  - `.icon-btn` / `.mobile-menu-btn` grow to 44px under 480px.
  - Tab close buttons are always visible under `(hover: none), (pointer: coarse)`.
  - Safe-area insets: header top, BottomBar left/right/bottom, more-menu offset, sheets.
  - `viewport-fit=cover` in `index.html`; theme-color matches the manifest.
  - Fixed-width dialogs (Version history, Vault rename, Template picker, Help) clamp with
    `min(..., 94vw)`; the editor format strip scrolls instead of clipping.

Verified by `npm run test:mobile` (build first). Desktop regression coverage:
`npm run check`, `npm run build`, `npm run test:e2e`, `npm run test:smoke`.

## Android shell — recipe (not yet scaffolded)

No `src-tauri/gen/android` exists, and this machine has no Android SDK/JDK, so no APK
has been produced. On a machine with Android Studio + JDK 17:

```powershell
npm run tauri android init
npm run tauri android build
```

Before shipping, decide these parity gaps (they are code, not layout):

| Desktop | Mobile replacement needed |
| --- | --- |
| Python sidecars (memory, LLM, STT/TTS) | cloud API or bundled-on-device model; `sidecar.rs` cannot spawn Python on Android |
| binary-backed export (`convert.rs`) | in-app HTML→PDF or share the HTML/Markdown |
| Tray + `tray-capture` | notification / share-target plugin |
| `fs_reveal`, absolute vault path, `<a download>` | Storage Access Framework / share sheet; `commands.rs` vault commands need a mobile path |
| File watcher (`file-changed` event) | no equivalent; rely on in-app writes |
| Updater plugin | store-managed updates |

`tauri.conf.json` defines the desktop `main` and `widget` windows; the Windows
platform config adds the NSIS bundle and native sidecar build hook. Android
window/capability entries are still added as part of `android init`. The existing
`widget` label is already listed in `capabilities/default.json`; any future
Android-only window must be added there too or its `invoke` calls fail silently.
