<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Doc } from "$lib/api";
  import { currentDoc, openTabs } from "$lib/stores/app";
  import { settings } from "$lib/stores/settings";
  import { fetchPlaceStamp } from "$lib/stamp";
  import { showToast } from "$lib/stores/notifications";
  import MicButton from "$lib/components/MicButton.svelte";
  import EditorPane from "$lib/components/EditorPane.svelte";
  import DeleteButton from "$lib/components/DeleteButton.svelte";

  let today = $state(formatDate(new Date()));
  let selectedDate = $state(today);
  let logEntries = $state<Doc[]>([]);
  let touchedToday = $state<[string, string, string][]>([]);
  let quickCapture = $state("");
  let calendarMonth = $state(new Date());
  let loading = $state(false);
  let navCollapsed = $state(false);
  let touchedCollapsed = $state(false);

  /** The day list + calendar dots. Reloaded after every mutation so a
   * newly created day appears immediately instead of after a restart. */
  async function refreshEntries() {
    try {
      logEntries = await api.logListEntries(60);
    } catch (e) {
      console.error("Failed to list log entries:", e);
      showToast("Couldn't load past logs — check the vault backend", "error");
    }
  }

  /** Docs touched today (derived, never stored) for the daily-note footer. */
  async function loadTouchedToday() {
    try {
      const recent = await api.dashboardRecentDocs(50);
      // Local date, not UTC: toISOString is a day off near midnight.
      const prefix = formatDate(new Date());
      touchedToday = recent.filter(([, , updatedAt]) => {
        const day = updatedAt.slice(0, 10);
        return day >= prefix && day <= formatDate(new Date(Date.now() + 86400000));
      });
    } catch {
      touchedToday = [];
    }
  }

  async function openTouched(id: string) {
    try {
      const doc = await api.docGet(id);
      $currentDoc = doc;
      if (!$openTabs.find((t) => t.id === doc.id)) {
        $openTabs = [doc, ...$openTabs];
      }
      await api.usageRecord(doc.id, "open");
    } catch (e) {
      console.error("Failed to open doc:", e);
    }
  }

  function formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function formatDisplayDate(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00");
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
  }

  function getCalendarDays(month: Date): (string | null)[] {
    const year = month.getFullYear();
    const m = month.getMonth();
    const firstDay = new Date(year, m, 1).getDay();
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const days: (string | null)[] = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(formatDate(new Date(year, m, i)));
    }
    return days;
  }

  function prevMonth() {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  }

  function nextMonth() {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  }

  function getMonthLabel(month: Date): string {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${months[month.getMonth()]} ${month.getFullYear()}`;
  }

  function isToday(dateStr: string | null): boolean {
    return dateStr === today;
  }

  function isSelected(dateStr: string | null): boolean {
    return dateStr === selectedDate;
  }

  function hasEntry(dateStr: string | null): boolean {
    if (!dateStr) return false;
    return logEntries.some((e) => e.title === dateStr);
  }

  async function selectDate(dateStr: string | null) {
    if (!dateStr) return;
    selectedDate = dateStr;
    loading = true;
    try {
      const doc = await api.logGetOrCreate(dateStr);
      $currentDoc = doc;
      if (!$openTabs.find((t) => t.id === doc.id)) {
        $openTabs = [doc, ...$openTabs];
      }
      await api.usageRecord(doc.id, "open");
      stampFreshLog(doc, dateStr).catch(() => {});
    } catch (e) {
      console.error("Failed to open log:", e);
    }
    loading = false;
  }

  /**
   * Opt-in place/weather stamp (A11.9): only for today's note, only when
   * it was just created, only once — never rewrites history.
   */
  async function stampFreshLog(doc: Doc, dateStr: string) {
    if (!$settings.logsStampPlace || dateStr !== today) return;
    if (Date.now() - +new Date(doc.created_at) > 120000) return;
    if (doc.content.includes("📍")) return;
    const stamp = await fetchPlaceStamp();
    if (!stamp) return;
    const updated = await api.docSave(doc.id, undefined, `${doc.content ?? ""}\n\n${stamp}\n`);
    if ($currentDoc?.id === doc.id) $currentDoc = updated;
  }

  async function handleQuickCapture() {
    if (!quickCapture.trim()) return;
    try {
      const doc = await api.logGetOrCreate(selectedDate);
      const timestamp = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      const block = `\n\n## ${timestamp}\n\n${quickCapture.trim()}\n`;
      const updated = await api.docSave(doc.id, undefined, `${doc.content ?? ""}${block}`);
      quickCapture = "";
      if ($currentDoc?.id === doc.id) {
        $currentDoc = updated;
      }
      logEntries = logEntries.map((e) => (e.id === doc.id ? updated : e));
      await loadTouchedToday();
    } catch (e) {
      console.error("Quick capture failed:", e);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleQuickCapture();
    }
  }

  onMount(async () => {
    try {
      logEntries = await api.logListEntries(60);
    } catch (e) {
      console.warn("No log entries yet");
    }
    await selectDate(today);
    await loadTouchedToday();
  });
</script>

<div class="logs-workspace" class:nav-collapsed={navCollapsed}>
  {#if !navCollapsed}
  <div class="logs-sidebar">
    <div class="calendar">
      <div class="calendar-header">
        <button onclick={prevMonth}>&#8249;</button>
        <span class="month-label">{getMonthLabel(calendarMonth)}</span>
        <span class="cal-actions">
          <button onclick={nextMonth}>&#8250;</button>
          <button onclick={() => (navCollapsed = true)} title="Hide calendar — focus editor" aria-label="Hide calendar">−</button>
        </span>
      </div>
      <div class="calendar-grid">
        {#each ["S", "M", "T", "W", "T", "F", "S"] as day}
          <div class="day-header">{day}</div>
        {/each}
        {#each getCalendarDays(calendarMonth) as dateStr}
          <button
            class="day-cell"
            class:today={isToday(dateStr)}
            class:selected={isSelected(dateStr)}
            class:has-entry={hasEntry(dateStr)}
            disabled={!dateStr}
            onclick={() => selectDate(dateStr)}
          >
            {dateStr ? parseInt(dateStr.split("-")[2]) : ""}
          </button>
        {/each}
      </div>
    </div>

    <div class="day-list">
      <div class="day-list-header">Recent Days</div>
      {#each logEntries.slice(0, 14) as entry}
        <button
          class="day-item"
          class:active={$currentDoc?.id === entry.id}
          onclick={() => selectDate(entry.title)}
        >
          <span class="day-date">{formatDisplayDate(entry.title)}</span>
          <span class="day-words">{entry.word_count} words</span>
        </button>
      {/each}
    </div>
  </div>
  {/if}

  <div class="logs-content">
    {#if navCollapsed}
      <div class="board-collapsed-note">
        <button class="capture-btn" onclick={() => (navCollapsed = false)} title="Show calendar" aria-label="Show calendar" style="width:auto;padding:0 12px;font-size:12px;height:28px;">Calendar</button>
        <span>Calendar hidden — editor has full width.</span>
      </div>
    {/if}
    <div class="quick-capture">
      {#if $settings.sttEnabled}
        <MicButton onTranscribe={(text) => {
          quickCapture = (quickCapture ? quickCapture + ' ' : '') + text;
        }} />
      {/if}
      <input
        bind:value={quickCapture}
        onkeydown={handleKeydown}
        placeholder="Quick capture... (Enter to save)"
        disabled={loading}
      />
      <button class="capture-btn" onclick={handleQuickCapture} disabled={loading || !quickCapture.trim()}>
        +
      </button>
    </div>

    <div class="current-log">
      {#if loading}
        <div class="loading">Loading...</div>
      {:else if $currentDoc}
        <div class="log-header">
          <h2>{formatDisplayDate($currentDoc.title)}</h2>
          <span class="word-count">{$currentDoc.word_count} words</span>
          <span class="log-header-spacer"></span>
          <DeleteButton
            doc={$currentDoc}
            label="Delete this day's note"
            onDeleted={(id) => {
              logEntries = logEntries.filter((e) => e.id !== id);
              // Deleted the open day: today always exists, so reopen it
              // (recreates a fresh note); other days stay deleted.
              if ($currentDoc && !logEntries.find((e) => e.id === $currentDoc!.id)) {
                selectDate($currentDoc.title === selectedDate ? selectedDate : today);
              }
            }}
          />
        </div>
        <div class="log-editor">
          <EditorPane />
        </div>
      {:else}
        <div class="empty-log">
          <span>Select a day or start writing</span>
        </div>
      {/if}
    </div>

    {#if touchedToday.length > 0}
      <div class="touched-today" class:collapsed={touchedCollapsed}>
        <button class="touched-header" onclick={() => (touchedCollapsed = !touchedCollapsed)} title={touchedCollapsed ? "Show touched today" : "Hide touched today"} aria-pressed={touchedCollapsed}>
          <span>Touched today</span>
          <span aria-hidden="true">{touchedCollapsed ? "+" : "−"}</span>
        </button>
        {#if !touchedCollapsed}
        {#each touchedToday as [id, title]}
          <button class="touched-item" onclick={() => openTouched(id)}>
            {title}
          </button>
        {/each}
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .logs-workspace {
    display: flex;
    height: 100%;
    overflow: hidden;
  }

  .logs-sidebar {
    width: 260px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    flex-shrink: 0;
  }

  .logs-workspace.nav-collapsed .logs-sidebar {
    display: none;
  }

  .cal-actions {
    display: flex;
    gap: 2px;
  }

  .calendar {
    padding: 12px;
    border-bottom: 1px solid var(--border);
  }

  .calendar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .calendar-header button {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    font-size: 16px;
    color: var(--text-secondary);
  }

  .calendar-header button:hover {
    background: var(--bg-hover);
  }

  .month-label {
    font-size: 13px;
    font-weight: 500;
  }

  .calendar-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
  }

  .day-header {
    font-size: 10px;
    color: var(--text-muted);
    text-align: center;
    padding: 4px 0;
  }

  .day-cell {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
  }

  .day-cell:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .day-cell.today {
    color: var(--accent);
    font-weight: 600;
  }

  .day-cell.selected {
    background: var(--accent);
    color: white;
  }

  .day-cell.has-entry::after {
    content: "";
    position: absolute;
    bottom: 2px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--success);
  }

  .day-cell {
    position: relative;
  }

  .day-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .day-list-header {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 4px 8px;
    margin-bottom: 4px;
  }

  .day-item {
    width: 100%;
    padding: 8px;
    border-radius: var(--radius-sm);
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
    color: var(--text-secondary);
    text-align: left;
  }

  .day-item:hover {
    background: var(--bg-hover);
  }

  .day-item.active {
    background: var(--bg-active);
    color: var(--accent);
  }

  .day-words {
    font-size: 11px;
    color: var(--text-muted);
  }

  .logs-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .quick-capture {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .quick-capture input {
    flex: 1;
    height: 36px;
  }

  .capture-btn {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    background: var(--accent);
    color: white;
    font-size: 18px;
  }

  .capture-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .touched-today {
    border-top: 1px solid var(--border);
    padding: 10px 16px 16px;
  }

  .touched-header {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 6px;
    cursor: pointer;
  }

  .touched-today.collapsed .touched-header {
    margin-bottom: 0;
  }

  .touched-item {
    display: block;
    width: 100%;
    text-align: left;
    font-size: 12px;
    color: var(--text-secondary);
    padding: 4px 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .touched-item:hover {
    color: var(--accent);
  }

  .capture-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .current-log {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 16px 16px 0 16px;
    min-height: 0;
  }

  .log-editor {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    border-top: 1px solid var(--border-subtle);
    margin: 0 -16px;
    padding: 0 16px;
  }

  .log-header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 12px;
    flex-shrink: 0;
  }

  .log-header-spacer {
    flex: 1;
  }

  .log-header h2 {
    font-size: 20px;
    font-weight: 600;
  }

  .word-count {
    font-size: 12px;
    color: var(--text-muted);
  }

  .loading, .empty-log {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    font-size: 14px;
  }
</style>
