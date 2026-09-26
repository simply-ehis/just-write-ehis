PURPOSE: why installs show "unknown publisher" + signing options and costs
OWNS: code-signing decisions, post-build sign steps, SmartScreen expectations
READ-WHEN: publisher warning appears, buying a certificate, wiring signing into release builds
KEY-FILES: src-tauri/tauri.conf.json (no signing keys live here), release bundle output
INVARIANTS: no free trusted signature exists for private/closed apps; never self-sign for distribution
GOTCHAS: EV no longer skips SmartScreen (2024+); reputation accrues per-certificate over installs
UPDATED: 2026-09-26

# SIGNING.md — "Unknown publisher" and what actually fixes it

> PURPOSE: explain the install-time warning and the real options.
> READ WHEN: the installer shows "unknown publisher", or before spending money on a certificate.

## Why it says "unknown publisher"

Windows shows a verified publisher name only for binaries carrying an
**Authenticode signature from a trusted CA**. Our installer is unsigned,
so Windows reports "unknown publisher" and SmartScreen may block it
outright. This is not a bug in the app or the installer config — no
`tauri.conf.json` setting can substitute for a signature (the schema has
no Windows signing keys; signing is a post-build step with external
tooling). The in-app updater signatures (`.sig` minisign files) prove
*update authenticity to the app itself* — they do not affect the Windows
publisher warning at all.

## Options, verified September 2026

| Option | Cost | Publisher shown | Verdict for us |
|---|---|---|---|
| OV certificate (Sectigo/DigiCert via reseller) | ~$70–300/yr | Your verified name | **The fix, when funded.** Worldwide, works for private apps. |
| Azure Trusted Signing | ~$9.99/mo | Your org name | Individuals: USA/Canada only. Not free. |
| SignPath Foundation | Free | "SignPath Foundation" | **Ineligible**: requires public repo + OSI license. Ours is private. |
| Microsoft Store (MSIX) | Free (Store handles signing) | Trusted, no warnings | Real alternative, but requires Store submission + MSIX packaging — a separate project. |
| EV certificate | $400+/yr | Your name | Not worth it: since 2024 it grants no faster SmartScreen trust than OV. |
| Self-signed certificate | Free | Still "unknown", still blocked | **Never for distribution.** Dev machines only. |
| Nothing (current state) | $0 | Unknown | Users click through "More info → Run anyway", some enterprises block outright. |

## Two truths that surprise people

1. **Even a paid signature warns at first.** SmartScreen reputation accrues per certificate over installs/time. Day-one signed builds can still warn; it fades as installs accumulate. There is no instant-bypass product anymore.
2. **The updater key and the code certificate are unrelated.** The minisign keypair (`just-write-ehis.key`) authenticates *updates to the app*. Authenticode authenticates *the installer to Windows*. You need both; neither substitutes for the other.

## When funded: wiring it in (post-build step)

1. Buy OV, complete CA identity validation (1–8 days).
2. After `npm run tauri build`, sign both artifacts before publishing:
   `just-write-ehis.exe` and `Just Write ehis_*_x64-setup.exe`
   (signtool/osslsigncode with RFC 3161 timestamping so the signature
   outlives the certificate).
3. Ship the signed installer; SmartScreen reputation starts accruing.
4. No source or config changes needed — signing happens outside the build.

## Until then

Keep shipping unsigned; the Support page ("What happens next" + install
notes) is the right place to tell users to expect the warning and why
it's safe. Do not self-sign to make the dialog prettier — a
self-signed prompt trains the exact click-through habit attackers rely on.
