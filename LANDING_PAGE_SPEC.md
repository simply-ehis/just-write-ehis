# Landing Page Spec — Just Write ehis

## Purpose
Product page for Just Write ehis. Closed-source, paid app. The page should make someone want to download the trial, and then want to pay for the full version. Warm, honest, no tricks.

## Tone
Warm editorial. Think: a piece in *The New Yorker* about a tool, not a Google Ads landing page. Long-form text, good typography, no stock photos, no fake testimonials, no "revolutionary" language.

The voice should feel like a person talking about something they care about. Not a company selling something.

---

## Monetization Model

### Structure: Free Download + One-Time Pro Purchase

| | Free | Pro |
|---|---|---|
| **Price** | $0 | $29 one-time |
| **Trial** | 14-day full access, no card required | |
| **Editor** | Full CodeMirror 6 editor | Same |
| **Workspaces** | Inbox, Notes, Just Write | All (Novel, Script, Canvas, Reader, Logs, Projects) |
| **Split Writing** | No | Yes |
| **Beat Board** | No | Yes |
| **AI Assist** | No | Yes (bring your own key) |
| **Rhythm** | No | Yes |
| **Ghosts** | No | Yes |
| **Atlas** | No | Yes |
| **Export** | Markdown only | Markdown, DOCX, EPUB, PDF |
| **Templates** | 2 basic | All templates |
| **Themes** | Light + Dark | All themes + custom |
| **Updates** | Bug fixes only | All updates for 1 year |
| **License** | Single device | Up to 3 devices |

### Why One-Time, Not Subscription
- Writers hate subscriptions (Scrivener model works, Ulysses backlash was real)
- No recurring server costs — it's a local-first desktop app
- $29 is impulse-buy territory for a tool you use daily
- No need to justify ongoing costs — the app works offline forever

### Payment Delivery
- **Gumroad** or **LemonSqueezy** — handles payments, license keys, delivery
- Buyer gets a license key via email
- App validates key locally (no phone-home required for offline use)
- Periodic online check (optional) to catch shared keys

### License Key Flow
1. User downloads free trial (full features, 14 days)
2. After 14 days, app locks to free-tier features
3. User buys Pro on landing page → gets license key via email
4. User enters key in app Settings → unlocks Pro forever
5. Key is stored locally, works offline

---

## Color Palette

| Token | Hex | Use |
|-------|-----|-----|
| `--bg` | `#FAF7F2` | Page background (warm off-white) |
| `--bg-deep` | `#F0ECE4` | Section alternates |
| `--text` | `#2C2825` | Body text (warm near-black) |
| `--text-muted` | `#7A7268` | Captions, secondary |
| `--accent` | `#C45D3E` | Links, CTAs, highlights (warm terracotta) |
| `--accent-hover` | `#A8492F` | Hover state |
| `--border` | `#E0DBD3` | Dividers, card edges |
| `--code-bg` | `#F5F1EA` | Code blocks, terminal snippets |

Dark mode (optional, future):
| `--bg` | `#1A1816` |
| `--text` | `#E8E2DA` |
| `--accent` | `#E07A5F` |

---

## Typography

| Role | Font | Weight | Size |
|------|------|--------|------|
| Display | Inter or System | 700 | 48–56px |
| Heading | Inter or System | 600 | 28–32px |
| Subhead | Inter or System | 400 | 18–20px |
| Body | Inter or System | 400 | 16–17px (1.7 line-height) |
| Caption | Inter or System | 400 | 13–14px |
| Code | JetBrains Mono / Fira Code | 400 | 14px |

System font stack with Inter as priority:
```
'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif
```

---

## Page Structure

### 1. Hero — "What is this?"
Full viewport height. Warm bg. No hero image — just type.

```
Just Write ehis

A writing app that stays out of your way.

[Start Writing — Free]  [See What's Pro ($29)]
```

- Display size title, subhead in body color
- Two CTAs: primary (filled terracotta "Start Writing"), secondary (outlined "See What's Pro")
- Below the fold: honest social proof:
  *"Built by one person. 14-day trial. No credit card."*

---

### 2. The Problem — "Why does this exist?"
Single column, max-width 680px. Long-form paragraph style.

Copy direction:
> Most writing apps are either too simple (a blank box) or too complex (a project management tool with a writing mode). Just Write ehis sits in the middle — enough structure to keep you organized, enough simplicity to stay out of your head.

2–3 paragraphs. Conversational. No bullet lists here.

---

### 3. Features — "What does it do?"
Grid of feature cards. 3 columns on desktop, 1 on mobile.

Each card:
- Small icon (line icon, 24px, terracotta)
- Feature name (heading weight)
- 1–2 sentence description
- Small badge if Pro-only: `<span class="pro-badge">Pro</span>`

**Free features:**
1. **Full Editor** — CodeMirror 6. Markdown, spell check, themes.
2. **Inbox** — Quick capture. Dump ideas, sort later.
3. **Notes** — Freeform notes with folders.
4. **Export** — Markdown export.

**Pro features ($29):**
5. **Beat Board** — Visual story structure. Acts, sequences, scenes. Drag to reorder.
6. **Split Writing** — Side-by-side editing. Write on one side, reference on the other.
7. **AI Assist** — Built-in AI panel. Bring your own key. Never leaves your machine.
8. **Rhythm** — See your prose as a waveform. Paragraph density at a glance.
9. **Ghosts** — Fork a scene, try a different direction, compare side by side.
10. **Atlas** — Your writing history visualized as a star sky. Earned over time.
11. **Full Export** — DOCX, EPUB, PDF. Compile a full manuscript from scenes.
12. **All Workspaces** — Novel, Script, Canvas, Reader, Logs, Projects.

Cards should have subtle border, no shadow, slight bg tint on hover. Pro cards have a faint terracotta left border.

---

### 4. How It Feels — "Show, don't tell"
Full-width section with 2–3 screenshots of the actual app.

No mockups. Real screenshots, cropped to the interesting parts:
- The novel workspace with beat board + editor
- The AI panel in action
- The home page with Atlas star sky

Screenshots sit on the warm bg-deep, with a thin border. Captions below each:
```
Fig 1. The novel workspace — beat board on the left, editor on the right.
Fig 2. AI assist panel — bring your own provider, nothing leaves your machine.
Fig 3. Atlas — your writing history, earned over time.
```

---

### 5. The Pro Pitch — "What do you get for $29?"
Dedicated section. Not a pricing table — a honest conversation.

```
Just Write ehis is free to use. The basics work, no tricks.

Pro unlocks everything else. One payment, $29. No subscription.
No account. No cloud. You get a license key, you enter it, you're done.

14-day trial. Full access. No credit card.
If you like it, pay once and own it.
```

Maybe a simple comparison:
```
Free                          Pro ($29)
─────────────────────────     ─────────────────────────
Editor, Inbox, Notes          Everything in Free
Markdown export               + Beat Board, Split, AI
                              + Rhythm, Ghosts, Atlas
                              + DOCX, EPUB, PDF export
                              + All workspaces
                              + All themes
                              + 1 year of updates
                              + 3 device license
```

---

### 6. Tech Stack — "Under the hood"
Minimal section. Just the stack, no explanations.

```
Tauri · Rust · Svelte · CodeMirror 6 · SQLite
```

Styled as a single line, monospace, muted color.

---

### 7. Download / Get Started
Simple, centered. This is the conversion point.

```
Start writing today.

Download Just Write ehis
Free · 14-day trial · No credit card · Windows

[Download v0.2.1 for Windows]

macOS and Linux coming soon.
```

Below the button, small text:
```
Already have a license key? Open the app → Settings → License.
```

---

### 8. Footer
Minimal.

```
© 2026 Ehis · Questions? hello@justwriteehis.com
```

Maybe a small "Made with Rust and Svelte" note.

---

## Layout Rules

- **Max content width:** 720px for text, 1080px for screenshots/grids
- **Section spacing:** 80–100px between sections
- **No sticky nav.** Just a clean scroll. Maybe a minimal fixed header that appears after scrolling past hero.
- **No animations** except: subtle fade-in on scroll for sections (CSS `@keyframes` + `IntersectionObserver`)
- **Mobile:** Single column, 16px body, full-width screenshots, stacked feature cards

---

## File Structure

```
site/
  index.html
  styles.css
  assets/
    screenshots/
      novel-workspace.png
      ai-panel.png
      atlas-home.png
  favicon.ico
```

Single HTML file. No build step. No framework. Just HTML + CSS + minimal JS for scroll effects.

---

## What NOT to do

- No stock photos or illustrations
- No "Join 10,000+ users" (there aren't 10,000+ users)
- No fake urgency ("Limited time offer!")
- No testimonials section (not yet, not fake)
- No cookie banner (it's a static page)
- No heavy JS frameworks
- No carousels or sliders
- No gradient text or glass morphism
- No emojis in the copy
- No "AI-powered" in the hero (it's a feature, not the identity)

---

## Open Questions

1. **Domain?** `justwrite.app`? `justwriteehis.com`? GitHub Pages subdomain?
2. **Gumroad vs LemonSqueezy?** LemonSqueezy has better DX, Gumroad has more name recognition.
3. **Screenshots needed.** Need to take 2–3 actual app screenshots after next build.
4. **Analytics?** Plausible? Umami? None?
5. **Contact method?** Email in footer? A simple contact form?
6. **License key integration.** How does the app validate keys? Need to build a `license.rs` module — local validation with optional online check.
