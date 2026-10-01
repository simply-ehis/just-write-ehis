<script lang="ts">
  /**
   * SupportPane — Settings → Support: about the maker, getting help, and
   * sending feedback through the public GitHub issue tracker. Feedback is
   * composed into a prefilled issue (or copied) — nothing is ever sent
   * automatically; the tap is the consent.
   */
  import { onMount } from "svelte";
  import { settings } from "$lib/stores/settings";
  import { api, getSlowCalls, isBrowserPreview } from "$lib/api";
  import { readSessionHealth } from "$lib/sessionHealth";
  import { showToast } from "$lib/stores/notifications";
  import { getAppVersion } from "$lib/updates";
  import { APP_VERSION } from "$lib/version";
  import {
    COMPANY_BLURB,
    COMPANY_NAME,
    GITHUB_OWNER,
    GITHUB_REPO,
    SEVERITY_LABELS,
    SUPPORT_SITE_URL,
    buildDiagnosticsSnapshot,
    buildFeedbackText,
    buildIssueUrl,
    formatSlowCalls,
    type FeedbackSeverity,
  } from "$lib/support";

  let makerLogo = $derived($settings.themeMode === "dark" ? "ehis-logo-light.svg" : "ehis-logo-dark.svg");

  let appVersion = $state(APP_VERSION);
  let severity = $state<FeedbackSeverity>("bug");
  let subject = $state("");
  let message = $state("");
  let sending = $state(false);

  onMount(() => {
    getAppVersion(APP_VERSION).then((v) => (appVersion = v));
  });

  function snapshot(): string {
    const health = readSessionHealth();
    const slow = getSlowCalls();
    return buildDiagnosticsSnapshot({
      version: appVersion,
      desktop: !isBrowserPreview(),
      theme: $settings.theme,
      themeMode: $settings.themeMode,
      bootMs: health.bootMs,
      prevExit: health.prevExit,
      stuckStep: health.stuckStep,
      slowCalls: slow.length === 0 ? undefined : formatSlowCalls(slow),
    });
  }

  function openIssueTracker() {
    if (sending) return;
    sending = true;
    try {
      const { url, truncated } = buildIssueUrl({ subject, message, severity }, snapshot());
      const win = window.open(url, "_blank", "noopener");
      if (!win) {
        showToast("Popup blocked — copy the issue text instead, or allow popups", "warning");
      } else if (truncated) {
        showToast("Tracker opened — message was long, paste the rest manually", "warning");
      } else {
        showToast("Issue tracker opened with your feedback", "success");
      }
    } catch (e) {
      showToast(`Couldn't open the tracker: ${e instanceof Error ? e.message : e} — use Copy instead`, "error");
    } finally {
      sending = false;
    }
  }

  async function copyFeedback() {
    try {
      await navigator.clipboard.writeText(buildFeedbackText({ subject, message, severity }, snapshot()));
      showToast("Feedback copied — paste it into a new GitHub issue", "success");
    } catch (e) {
      showToast(`Couldn't copy: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(snapshot());
      showToast("Diagnostics copied to clipboard", "success");
    } catch (e) {
      showToast(`Couldn't copy: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function copySiteUrl() {
    try {
      await navigator.clipboard.writeText(SUPPORT_SITE_URL);
      showToast("Site address copied — paste it in your browser", "success");
    } catch (e) {
      showToast(`Couldn't copy: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  function openSite() {
    // No opener plugin in this shell: best-effort new tab (works in the
    // browser preview), otherwise the copy button beside it is the path.
    try {
      const win = window.open(SUPPORT_SITE_URL, "_blank", "noopener");
      if (!win) showToast("Popup blocked — use Copy and paste it in your browser", "warning");
    } catch (e) {
      showToast(`Couldn't open the browser: ${e instanceof Error ? e.message : e} — use Copy`, "error");
    }
  }
</script>

<div class="settings-section">
  <h3>About {COMPANY_NAME}</h3>
  <img class="maker-logo" src={makerLogo} alt="Simply Ehis logo" />
  <p class="setting-desc">{COMPANY_BLURB}</p>
  <div class="setting-row">
    <span class="setting-label">Website</span>
    <span class="value">{SUPPORT_SITE_URL}</span>
    <span class="row-btns">
      <button class="secondary-btn" onclick={openSite}>Open</button>
      <button class="secondary-btn" onclick={copySiteUrl}>Copy</button>
    </span>
  </div>
  <div class="setting-row">
    <span class="setting-label">Version</span>
    <span class="value">{appVersion}</span>
  </div>
  <div class="setting-row">
    <span class="setting-label">Issue tracker</span>
    <span class="value">github.com/{GITHUB_OWNER}/{GITHUB_REPO}/issues</span>
  </div>
</div>

<div class="settings-section">
  <h3>Get help</h3>
  <p class="setting-desc">Press <kbd>?</kbd> anywhere for keyboard shortcuts and feature blurbs. For setup guides see the docs folder: USER-GUIDE, EXPORT, MODELS, UPDATES.</p>
  <div class="setting-row">
    <span class="setting-label">Diagnostics snapshot</span>
    <button class="secondary-btn" onclick={copyDiagnostics}>Copy diagnostics</button>
  </div>
  <p class="setting-desc">Version, platform, and theme — paste it into your issue so the problem is reproducible. No documents or secrets are included.</p>
</div>

  <div class="settings-section">
  <h3>Send feedback</h3>
  <p class="setting-desc">Bug, idea, or question — open a prefilled GitHub issue with everything filled in. Nothing leaves this device until you press Submit there.</p>
  <div class="setting-row">
    <label for="support-severity">Kind</label>
    <select id="support-severity" bind:value={severity}>
      {#each Object.entries(SEVERITY_LABELS) as [value, label]}
        <option {value}>{label}</option>
      {/each}
    </select>
  </div>
  <div class="setting-row">
    <label for="support-subject">Subject</label>
    <input id="support-subject" type="text" bind:value={subject} placeholder="One-line summary" maxlength="200" />
  </div>
  <label class="feedback-label" for="support-message">Details</label>
  <textarea
    id="support-message"
    class="feedback-textarea"
    bind:value={message}
    placeholder="What happened, what you expected, steps to reproduce…"
    rows="7"
  ></textarea>
  <div class="export-import-row">
    <button class="primary-btn" onclick={openIssueTracker} disabled={sending}>
      {sending ? "Opening…" : "Open GitHub issue"}
    </button>
    <button class="secondary-btn" onclick={copyFeedback}>Copy issue text</button>
  </div>
</div>

<div class="settings-section">
  <h3>What happens next</h3>
  <p class="setting-desc">Your draft opens as a new public GitHub issue with everything filled in — review it there before submitting. Issues are public, so keep secrets and private document text out. Useful reports include the diagnostics snapshot above plus the exact steps that reproduce the problem.</p>
</div>

<style>
  /* Shared settings look, duplicated here on purpose: Svelte scopes
     SettingsPane's stylesheet to its own markup, so a lazily loaded pane
     must carry the classes it renders or it ships unstyled. */
  .settings-section h3 {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 20px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }

  .setting-row label,
  .setting-label {
    font-size: 13px;
    color: var(--text-primary);
  }

  .setting-row .value {
    font-size: 13px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .setting-row input[type="text"],
  .setting-row select {
    width: 240px;
  }

  .setting-desc {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin: var(--space-1) 0 var(--space-2);
  }

  .export-import-row {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .primary-btn {
    padding: 8px 16px;
    border: none;
    border-radius: var(--radius-md);
    background: var(--accent-primary);
    color: var(--text-on-accent);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .primary-btn:hover {
    opacity: 0.9;
  }

  .secondary-btn {
    padding: 8px 16px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .secondary-btn:hover {
    background: var(--surface-overlay);
  }

  .row-btns {
    display: inline-flex;
    gap: 8px;
  }

  .maker-logo {
    display: block;
    width: 168px;
    max-width: 60%;
    height: auto;
    margin: 4px 0 16px;
  }

  .feedback-label {
    display: block;
    font-size: 13px;
    color: var(--text-primary);
    margin: 12px 0 6px;
  }

  .feedback-textarea {
    width: 100%;
    min-height: 140px;
    padding: var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-relaxed);
    resize: vertical;
  }

  .feedback-textarea:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  kbd {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 1px 6px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
  }
</style>
