<script lang="ts">
  import { onMount } from "svelte";
  import { api, type ChatMessage, type Conversation } from "$lib/api";
  import { currentDoc, currentWorkspace, aiPanelOpen, structurizePreset } from "$lib/stores/app";
  import { settings } from "$lib/stores/settings";
  import { writeBack } from "$lib/stores/writeBack";
  import { splitTarget } from "$lib/stores/split";
  import { globalLoading } from "$lib/stores/loading";
  import { assertAiAllowedForDoc } from "$lib/stores/lock";
  import { showToast } from "$lib/stores/notifications";
  import { isBrowserPreview } from "$lib/api";
  import { ensureHarness } from "$lib/harness";
  import { testProvider } from "$lib/providerTest";
  import { markUsed } from "$lib/features";
  import Icon from "$lib/components/Icon.svelte";

  function cancelGeneration() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    generating = false;
    globalLoading.set(false);
  }

  /**
   * Memory + scrub gate for outgoing prompts (non-blank mode only).
   * Recall enhances; scrubbing fails closed — a missing sidecar blocks
   * the call instead of leaking secrets.
   */
  async function preparePrompt(
    prompt: string,
    system: string
  ): Promise<{ prompt: string; system: string }> {
    if (blankMode) return { prompt, system };
    let nextPrompt = prompt;
    let nextSystem = system;
    if ($settings.aiMemoryEnabled && !isBrowserPreview()) {
      try {
        const facts = await api.memoryRecall(nextPrompt);
        if (facts.trim()) nextSystem += `\n\n${facts}`;
      } catch {
        /* memory is enhancement; absence never blocks */
      }
    }
    if ($settings.scrubSecrets) {
      const ok = await ensureHarness();
      if (!ok) {
        throw new Error("Secret scrubbing is on but the memory sidecar isn't running.");
      }
      nextPrompt = await api.memoryRedact(nextPrompt);
      nextSystem = await api.memoryRedact(nextSystem);
    }
    return { prompt: nextPrompt, system: nextSystem };
  }

  async function toggleSidecar() {
    if (sidecarRunning) {
      await api.sidecarStop();
      sidecarRunning = false;
      return;
    }
    const harnessDir = $settings.sidecarHarnessDir.trim();
    if (!harnessDir) {
      showToast("Set the harness directory in Settings → AI & Providers first", "warning");
      return;
    }
    try {
      await api.sidecarStart($settings.pythonPath || "python", harnessDir);
      sidecarRunning = true;
    } catch (e) {
      showToast(`Sidecar failed to start: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

let mode = $state<"chat" | "composer" | "ghost" | "structurize">("chat"); let blankMode = $state(false);
  let minimized = $state(false);

  // Initialize blankMode from settings
  $effect(() => {
    blankMode = $settings.blankModeDefault;
  });

  // Persist blankMode toggle to settings
  function toggleBlank() {
    blankMode = !blankMode;
    settings.update(s => ({ ...s, blankModeDefault: blankMode }));
  }

  $effect(() => {
    try {
      const raw = localStorage.getItem("jwe-ai-min");
      if (raw === "1") minimized = true;
    } catch (e) {
      console.warn("Failed to load AI panel state:", e);
    }
  });

  $effect(() => {
    try {
      localStorage.setItem("jwe-ai-min", minimized ? "1" : "0");
    } catch (e) {
      console.warn("Failed to save AI panel state:", e);
    }
  });

  // Inline structurize: consume preset from editor selection.
  $effect(() => {
    const preset = $structurizePreset;
    if (preset !== null) {
      structurizeInput = preset;
      mode = "structurize";
      structurizePreset.set(null);
    }
  });
  let input = $state("");
  let messages = $state<ChatMessage[]>([]);
  let conversation = $state<Conversation | null>(null);
  let generating = $state(false);
  let composerPrompt = $state("");
  let composerOutput = $state("");
  let hoveredMsgIdx = $state<number | null>(null);
  let sidecarRunning = $state(false);
  let sidecarConfidence = $state<number | null>(null);
  let abortController = $state<AbortController | null>(null);
  let lastSendTime = $state(0);
  let lastUserMessage = $state("");

  let endpointUnreachable = $state(false);

  // Write-back target: the open doc by default, the Write split pane
  // when one is open and picked. Resets whenever the split changes.
  let wbTargetOverride = $state<string | null>(null);
  let splitLive = $derived($splitTarget && $splitTarget.id !== $currentDoc?.id ? $splitTarget : null);
  let wbTargetId = $derived(wbTargetOverride ?? $currentDoc?.id ?? null);

  $effect(() => {
    void $splitTarget?.id;
    wbTargetOverride = null;
  });

  // Chat history: past conversations persist in the backend; list + resume them here.
  let historyOpen = $state(false);
  let historyLoading = $state(false);
  let historyList = $state<Conversation[]>([]);
  let historyTitles = $state<Record<string, string>>({});

  function historyLabel(c: Conversation): string {
    return historyTitles[c.id] ?? `${c.mode} · ${formatHistoryDate(c.updated_at)}`;
  }

  function formatHistoryDate(iso: string): string {
    try {
      const d = new Date(iso);
      const today = new Date();
      if (d.toDateString() === today.toDateString()) {
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    } catch {
      return iso.slice(0, 10);
    }
  }

  async function openHistory() {
    historyOpen = !historyOpen;
    if (!historyOpen) return;
    historyLoading = true;
    try {
      const list = await api.conversationList();
      historyList = list.slice(0, 30);
      // Resolve a one-line preview per conversation (first user message).
      await Promise.all(
        historyList.map(async (c) => {
          if (historyTitles[c.id]) return;
          try {
            const msgs = await api.conversationGetMessages(c.id);
            const first = msgs.find((m) => m.role === "user");
            historyTitles[c.id] = first
              ? first.content.slice(0, 60) + (first.content.length > 60 ? "…" : "")
              : `${c.mode} · ${formatHistoryDate(c.updated_at)}`;
          } catch {
            historyTitles[c.id] = `${c.mode} · ${formatHistoryDate(c.updated_at)}`;
          }
        })
      );
    } catch (e) {
      showToast(`Couldn't load chat history: ${e instanceof Error ? e.message : e}`, "error");
      historyOpen = false;
    } finally {
      historyLoading = false;
    }
  }

  async function resumeConversation(c: Conversation) {
    try {
      const msgs = await api.conversationGetMessages(c.id);
      conversation = c;
      messages = msgs;
      mode = "chat";
      historyOpen = false;
    } catch (e) {
      showToast(`Couldn't open conversation: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  function startNewChat() {
    conversation = null;
    messages = [];
    historyOpen = false;
  }

  onMount(async () => {
    try {
      sidecarRunning = await api.sidecarIsRunning();
    } catch (e) {
      console.warn("Sidecar status check failed:", e);
    }
    // Surface a dead endpoint the moment the panel opens — not mid-sentence.
    try {
      const probe = await testProvider($settings.mainModelEndpoint, $settings.mainModelName);
      endpointUnreachable = !probe.ok;
    } catch {
      endpointUnreachable = true;
    }
  });

  let structurizeInput = $state("");
  let structurizeOutput = $state("");
  let structurizeAccepted = $state(false);
  const structurizePlaceholder = "Paste raw text here. Wrap instructions in {braces}. Example: {make this a table}, {expand each bullet to 2 paragraphs}, {draw a timeline}...";

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      sendMessage();
    }

    // Write-back shortcuts: Ctrl+Enter = insert last AI response, Ctrl+Shift+C = copy
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      const lastAi = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAi) {
        const docId = wbTargetId;
        if (!docId) {
          showToast("Open a document to write into", "warning");
          return;
        }
        writeBack.insert(lastAi.content, docId);
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === "C") {
      event.preventDefault();
      const lastAi = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAi) writeBack.copy(lastAi.content);
    }
  }

  function handleComposerKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      handleComposerGenerate();
    }
  }

  function highlightDirectives(text: string): string {
    return text.replace(/\{([^}]+)\}/g, '<span class="directive">{$1}</span>');
  }

  async function handleStructurize() {
    if (!structurizeInput.trim() || generating) return;

    const now = Date.now();
    if ($settings.aiRateLimitCooldown > 0 && now - lastSendTime < $settings.aiRateLimitCooldown) {
      showToast("Wait a moment before sending again", "warning");
      return;
    }

    generating = true;
    globalLoading.set(true);
    structurizeOutput = "";
    structurizeAccepted = false;
    try {
      let structurizeText = structurizeInput;
      if ($settings.scrubSecrets) {
        const ok = await ensureHarness();
        if (!ok) throw new Error("Secret scrubbing is on but the memory sidecar isn't running.");
        structurizeText = await api.memoryRedact(structurizeInput);
      }
      const response = await api.aiStructurize({
        text: structurizeText,
        workspace: $currentWorkspace,
        provider: $settings.mainModelEndpoint || undefined,
        model: $settings.mainModelName || undefined,
        api_key: $settings.apiKey || undefined,
      });
      structurizeOutput = response.result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let friendly = msg;
      if (msg.includes("401") || msg.includes("403")) friendly = "API key rejected — check your provider settings";
      else if (msg.includes("429")) friendly = "Rate limited — wait a moment";
      else if (msg.includes("408") || msg.includes("timed out")) friendly = "Request timed out — the model may be overloaded";
      else if (msg.includes("ECONNREFUSED") || msg.includes("network")) friendly = "Can't reach AI server — is it running?";
      showToast(`Structurize failed: ${friendly}`, "error");
      structurizeOutput = `Error: ${friendly}`;
    } finally {
      generating = false;
      globalLoading.set(false);
      lastSendTime = Date.now();
    }
  }

  function acceptStructurize() {
    if (!structurizeOutput) return;
    // Targeted replace: honors the Main/Split pick (previously untargeted,
    // which write panes dropped). Falls back to untargeted when no doc.
    writeBack.replace(structurizeOutput, wbTargetId ?? undefined);
    structurizeAccepted = true;
  }

  function dismissStructurize() {
    structurizeOutput = "";
    structurizeAccepted = false;
  }

  async function sendMessage() {
    if (!input.trim() || generating) return;

    // Rate limit: minimum 3s between sends
    const now = Date.now();
    if ($settings.aiRateLimitCooldown > 0 && now - lastSendTime < $settings.aiRateLimitCooldown) {
      showToast("Wait a moment before sending again", "warning");
      return;
    }

    if (!blankMode) {
      try {
        assertAiAllowedForDoc($currentDoc);
      } catch (e) {
        input = "";
        messages = [...messages, {
          id: `local-${Date.now()}`,
          conversation_id: conversation?.id ?? "",
          role: "assistant",
          content: `Locked: ${e instanceof Error ? e.message : String(e)}`,
          created_at: new Date().toISOString(),
        }];
        return;
      }
    }

    const userContent = input.trim();
    input = "";
    lastUserMessage = userContent;

    if (!conversation) {
      conversation = await api.conversationCreate(
        blankMode ? undefined : $currentDoc?.id,
        mode
      );
      // Keep the history list fresh without refetching.
      if (!historyList.some((c) => c.id === conversation!.id)) {
        historyList = [conversation, ...historyList].slice(0, 30);
      }
      historyTitles[conversation.id] = userContent.slice(0, 60) + (userContent.length > 60 ? "…" : "");
    }

    const userMsg = await api.conversationAddMessage(conversation.id, "user", userContent);
    messages = [...messages, userMsg];

    generating = true;
    globalLoading.set(true);
    try {
      let systemPrompt = blankMode
        ? "You are a helpful writing assistant."
        : `You are a writing assistant. The user is working on a document titled "${$currentDoc?.title ?? 'Untitled'}". Respond concisely and helpfully.`;

      // Inject AI persona (soul.md)
      if ($settings.aiPersona.trim()) {
        systemPrompt += `\n\nYour persona:\n${$settings.aiPersona}`;
      }

      // Inject workspace-specific context
      if (!blankMode && $currentDoc) {
        try {
          const wsContext = await api.getWorkspaceContext($currentDoc.id, $currentWorkspace);
          if (wsContext.trim()) {
            systemPrompt += `\n\nWorkspace context:\n${wsContext}`;
          }
        } catch (e) {
          console.warn('Workspace context failed, continuing without:', e);
        }

        // RAG context as well
        try {
          const ragContext = await api.ragGetContext($currentDoc.id, userContent, 3);
          if (ragContext.trim()) {
            systemPrompt += `\n\nRelevant context from the document:\n${ragContext}`;
          }
        } catch (e) {
          console.warn('RAG context failed, continuing without:', e);
        }
      }

      // Memory recall + secret scrub run before anything leaves the app.
      const prepared = await preparePrompt(userContent, systemPrompt);

      // Stream tokens live into a placeholder, persist the full text once done.
      const placeholder: ChatMessage = {
        id: `stream-${Date.now()}`,
        conversation_id: conversation.id,
        role: "assistant",
        content: "",
        created_at: new Date().toISOString(),
      };
      messages = [...messages, placeholder];
      let streamed = "";
      abortController = new AbortController();
      const full = await api.aiGenerateStream(
        {
          prompt: prepared.prompt,
          system_prompt: prepared.system,
          mode,
          provider: $settings.mainModelEndpoint || undefined,
          model: $settings.mainModelName || undefined,
          max_tokens: mode === "composer" ? 4096 : 2048,
          api_key: $settings.apiKey || undefined,
        },
        (token) => {
          if (abortController?.signal.aborted) return;
          streamed += token;
          messages = messages.map((m) => (m.id === placeholder.id ? { ...m, content: streamed } : m));
        }
      );

      const aiMsg = await api.conversationAddMessage(conversation.id, "assistant", full);
      messages = messages.map((m) => (m.id === placeholder.id ? aiMsg : m));

      // Learn from the exchange for future recall (best-effort, silent).
      if (!blankMode && $settings.aiMemoryEnabled) {
        api.memoryLearn(`User: ${userContent}\nAssistant: ${full.slice(0, 1000)}`).catch(() => {});
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let friendly = msg;
      if (msg.includes("401") || msg.includes("403")) friendly = "API key rejected — check your provider settings";
      else if (msg.includes("429")) friendly = "Rate limited — wait a moment";
      else if (msg.includes("408") || msg.includes("timed out")) friendly = "Request timed out — the model may be overloaded";
      else if (msg.includes("ECONNREFUSED") || msg.includes("network")) friendly = "Can't reach AI server — is it running?";
      showToast(`AI generation failed: ${friendly}`, "error");
      const errorMsg = await api.conversationAddMessage(
        conversation.id,
        "assistant",
        `Error: ${friendly}`
      );
      messages = [...messages.filter((m) => !m.id.startsWith("stream-")), errorMsg];
    } finally {
      abortController = null;
      generating = false;
      globalLoading.set(false);
      lastSendTime = Date.now();
    }
  }

  async function handleComposerGenerate() {
    if (!composerPrompt.trim() || generating) return;

    const now = Date.now();
    if ($settings.aiRateLimitCooldown > 0 && now - lastSendTime < $settings.aiRateLimitCooldown) {
      showToast("Wait a moment before sending again", "warning");
      return;
    }

    try {
      assertAiAllowedForDoc($currentDoc);
    } catch (e) {
      composerOutput = `Locked: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }

    generating = true;
    globalLoading.set(true);
    composerOutput = "";
    abortController = new AbortController();
    try {
      const prepared = await preparePrompt(
        composerPrompt,
        "You are a professional writing assistant. Generate well-crafted prose based on the user's instructions."
      );
      await api.aiGenerateStream(
        {
          prompt: prepared.prompt,
          system_prompt: prepared.system,
          mode: "composer",
          provider: $settings.mainModelEndpoint || undefined,
          model: $settings.mainModelName || undefined,
          max_tokens: 4096,
          api_key: $settings.apiKey || undefined,
        },
        (token) => {
          if (abortController?.signal.aborted) return;
          composerOutput += token;
        }
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let friendly = msg;
      if (msg.includes("401") || msg.includes("403")) friendly = "API key rejected — check your provider settings";
      else if (msg.includes("429")) friendly = "Rate limited — wait a moment";
      else if (msg.includes("408") || msg.includes("timed out")) friendly = "Request timed out — the model may be overloaded";
      else if (msg.includes("ECONNREFUSED") || msg.includes("network")) friendly = "Can't reach AI server — is it running?";
      showToast(`Composer failed: ${friendly}`, "error");
      composerOutput = `Error: ${friendly}`;
    } finally {
      abortController = null;
      generating = false;
      globalLoading.set(false);
      lastSendTime = Date.now();
    }
  }

  function handleWriteBack(action: "insert" | "replace" | "append", content: string) {
    const docId = wbTargetId;
    if (!docId) {
      showToast("Open a document to write into", "warning");
      return;
    }
    switch (action) {
      case "insert": writeBack.insert(content, docId); break;
      case "replace": writeBack.replace(content, docId); break;
      case "append": writeBack.append(content, docId); break;
    }
  }

  function handleCopy(content: string) {
    writeBack.copy(content);
  }

  function retryLastMessage() {
    if (!lastUserMessage || generating) return;
    input = lastUserMessage;
    lastUserMessage = "";
    sendMessage();
  }
</script>

<div class="ai-panel" class:minimized>
  <div class="ai-header">
    <div class="mode-tabs">
      {#if !minimized}
      <button class:active={mode === "chat"} onclick={() => mode = "chat"}>Chat</button>
      <button class:active={mode === "composer"} onclick={() => { mode = "composer"; markUsed("composer"); }}>Composer</button>
      <button class:active={mode === "structurize"} onclick={() => { mode = "structurize"; markUsed("structurize"); }}>Structurize</button>
      <button class:active={mode === "ghost"} onclick={() => { mode = "ghost"; markUsed("ghost"); }}>Ghost</button>
      {:else}
      <span class="min-title">AI</span>
      {/if}
    </div>
    <div class="header-actions">
      <button class="icon-btn" onclick={() => (minimized = !minimized)} title={minimized ? "Expand AI panel" : "Minimize AI panel"} aria-label={minimized ? "Expand AI panel" : "Minimize AI panel"} aria-pressed={minimized}>
        <Icon name={minimized ? "arrow-right" : "minus"} size={14} />
      </button>
      <button class="icon-btn" class:active={historyOpen} onclick={openHistory} title="Chat history" aria-label="Open chat history">
        <Icon name="history" size={15} />
      </button>
      {#if conversation || messages.length > 0}
        <button class="icon-btn" onclick={startNewChat} title="New chat" aria-label="Start new chat">
          <Icon name="plus" size={15} />
        </button>
      {/if}
      <button class="sidecar-toggle" class:active={sidecarRunning} onclick={toggleSidecar} title={sidecarRunning ? "Small model running" : "Start small model"}>
        <span class="sidecar-dot" class:running={sidecarRunning}></span>
        <span>Small Model</span>
      </button>
      <button class="toggle-blank" class:active={blankMode} onclick={toggleBlank}>
        {blankMode ? "Blank" : "Context"}
      </button>
      <button class="close-btn" onclick={() => $aiPanelOpen = false}>&times;</button>
    </div>
  </div>

  {#snippet wbTargetToggle()}
    {#if splitLive}
      <div class="wb-target" role="group" aria-label="Write-back target">
        <button
          class:active={!wbTargetOverride}
          onclick={() => (wbTargetOverride = null)}
          title="Write into {$currentDoc?.title ?? 'open doc'}"
        >Main</button>
        <button
          class:active={!!wbTargetOverride}
          onclick={() => { if (splitLive) wbTargetOverride = splitLive.id; }}
          title="Write into {splitLive.title}"
        >Split</button>
      </div>
    {/if}
  {/snippet}

  {#if !minimized}
  {#if historyOpen}
    <div class="history-dropdown" role="dialog" aria-label="Chat history">
      <div class="history-header">
        <span>Recent chats</span>
        <button class="history-new" onclick={startNewChat}>+ New</button>
      </div>
      {#if historyLoading}
        <div class="history-empty">Loading…</div>
      {:else if historyList.length === 0}
        <div class="history-empty">No past conversations yet.</div>
      {:else}
        <div class="history-list">
          {#each historyList as c}
            <button
              class="history-item"
              class:active={conversation?.id === c.id}
              onclick={() => resumeConversation(c)}
              title="Resume this conversation"
            >
              <span class="history-title">{historyLabel(c)}</span>
              <span class="history-meta">{c.mode} · {formatHistoryDate(c.updated_at)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if mode === "composer"}
    <div class="composer-view">
      <div class="composer-input">
        <textarea
          bind:value={composerPrompt}
          onkeydown={handleComposerKeydown}
          placeholder="Describe what you want to write... (Ctrl+Enter to generate)"
          rows="4"
        ></textarea>
        <button class="generate-btn" onclick={handleComposerGenerate} disabled={generating}>
          {generating ? "Generating..." : "Generate"}
        </button>
      </div>
      {#if composerOutput}
        <div class="composer-output">
          <div class="output-header">
            <span>Generated</span>
            {@render wbTargetToggle()}
            <div class="output-actions">
              <button class="action-btn icon-btn" onclick={() => handleWriteBack("insert", composerOutput)} title="Insert at cursor" aria-label="Insert at cursor">
                <Icon name="plus" size={14} />
              </button>
              <button class="action-btn icon-btn" onclick={() => handleWriteBack("replace", composerOutput)} title="Replace selection" aria-label="Replace selection">
                <Icon name="refresh" size={14} />
              </button>
              <button class="action-btn icon-btn" onclick={() => handleWriteBack("append", composerOutput)} title="Append to doc" aria-label="Append to doc">
                <Icon name="send" size={14} />
              </button>
              <button class="action-btn icon-btn" onclick={() => handleCopy(composerOutput)} title="Copy" aria-label="Copy">
                <Icon name="files" size={14} />
              </button>
            </div>
          </div>
          <div class="output-content">{composerOutput}</div>
        </div>
      {/if}
    </div>
  {:else if mode === "structurize"}
    <div class="structurize-view">
      <div class="structurize-input">
          <div class="input-label">
            <span>Paste text with <code>{'{{...}}'}</code> directives</span>
          </div>
        <div class="structurize-textarea-wrap">
          <div class="directive-highlight" aria-hidden="true">
            {@html highlightDirectives(structurizeInput || '')}
          </div>
          <textarea
            bind:value={structurizeInput}
            placeholder={structurizePlaceholder}
            rows="8"
          ></textarea>
        </div>
        <button class="generate-btn" onclick={handleStructurize} disabled={generating || !structurizeInput.trim()}>
          {generating ? "Structuring..." : "Structurize"}
        </button>
      </div>
      {#if structurizeOutput}
        <div class="structurize-output">
          <div class="output-header">
            <span>Result</span>
            {@render wbTargetToggle()}
            <div class="output-actions">
              <button class="action-btn icon-btn" onclick={acceptStructurize} title="Replace current selection with this" aria-label="Accept structurize result">
                <Icon name="check" size={14} />
              </button>
              <button class="action-btn icon-btn" onclick={() => handleWriteBack("insert", structurizeOutput)} title="Insert at cursor" aria-label="Insert at cursor">
                <Icon name="plus" size={14} />
              </button>
              <button class="action-btn icon-btn" onclick={() => handleWriteBack("append", structurizeOutput)} title="Append to doc" aria-label="Append to doc">
                <Icon name="send" size={14} />
              </button>
              <button class="action-btn icon-btn" onclick={() => writeBack.copy(structurizeOutput)} title="Copy" aria-label="Copy">
                <Icon name="files" size={14} />
              </button>
              <button class="action-btn icon-btn dismiss" onclick={dismissStructurize} title="Dismiss" aria-label="Dismiss">
                <Icon name="x" size={14} />
              </button>
            </div>
          </div>
          <div class="output-content">{structurizeOutput}</div>
        </div>
      {/if}
    </div>
  {:else if mode === "ghost"}
    <div class="ghost-view">
      <div class="ghost-info">
        <span class="icon"><Icon name="sparkle" size={28} /></span>
        <p>Ghost mode provides inline autocomplete as you type in the editor.</p>
        <p class="ghost-status">{$settings.ghostEnabled ? 'Enabled' : 'Disabled'} in settings</p>
      </div>
    </div>
  {:else}
    <div class="ai-messages">
      {#if messages.length === 0}
        <div class="empty-ai">
          <span class="icon"><Icon name="sparkle" size={28} /></span>
          <span>{blankMode ? "Blank mode — no context injected" : "Ask about your work"}</span>
          {#if !$settings.mainModelEndpoint.trim() && !$settings.smallModelEndpoint.trim()}
            <span class="endpoint-hint">No model connected — set an endpoint in Settings → AI & Providers, then Test it.</span>
          {:else if endpointUnreachable}
            <span class="endpoint-hint">Main model unreachable — is the server running? Check Settings → AI & Providers → Test.</span>
          {/if}
        </div>
      {:else}
        {#each messages as msg, idx}
          <div
            class="message"
            class:user={msg.role === "user"}
            role="article"
            onmouseenter={() => hoveredMsgIdx = idx}
            onmouseleave={() => hoveredMsgIdx = null}
          >
            <div class="role">{msg.role === "user" ? "You" : "AI"}</div>
            <div class="content">{msg.content}</div>
            {#if msg.content.startsWith("Error:")}
              <button class="retry-btn" onclick={retryLastMessage} disabled={generating} aria-label="Retry last message">
                <Icon name="refresh" size={12} /> Retry
              </button>
            {/if}
            {#if msg.role === "assistant" && hoveredMsgIdx === idx}
              <div class="writeback-bar">
                <button class="icon-btn" onclick={() => handleWriteBack("insert", msg.content)} title="Insert at cursor (Ctrl+Enter)" aria-label="Insert at cursor">
                  <Icon name="plus" size={14} />
                </button>
                <button class="icon-btn" onclick={() => handleWriteBack("replace", msg.content)} title="Replace selection" aria-label="Replace selection">
                  <Icon name="refresh" size={14} />
                </button>
                <button class="icon-btn" onclick={() => handleWriteBack("append", msg.content)} title="Append to doc" aria-label="Append to doc">
                  <Icon name="send" size={14} />
                </button>
                <button class="icon-btn" onclick={() => handleCopy(msg.content)} title="Copy (Ctrl+Shift+C)" aria-label="Copy">
                  <Icon name="files" size={14} />
                </button>
              </div>
            {/if}
          </div>
        {/each}
        {#if generating}
          <div class="message generating">
            <div class="role">AI</div>
            <div class="content">Thinking...</div>
            <button class="icon-btn cancel-btn" onclick={cancelGeneration} title="Cancel generation" aria-label="Cancel generation">
              <Icon name="x" size={14} />
            </button>
          </div>
        {/if}
      {/if}
    </div>

    <div class="ai-input">
      {#if !blankMode && $currentDoc}
        <div class="context-chip" title="Active context document">
          <span class="chip-icon"><Icon name="files" size={13} /></span>
          <span>{$currentDoc.title}</span>
          <span class="ws-label">{$currentWorkspace}</span>
        </div>
        {@render wbTargetToggle()}
      {/if}
      <div class="input-row">
        <textarea
          bind:value={input}
          onkeydown={handleKeydown}
          placeholder={blankMode ? "Ask anything..." : "Ask about your writing..."}
          rows="2"
          disabled={generating}
        ></textarea>
        <button class="send-btn icon-btn" onclick={sendMessage} disabled={generating || !input.trim()} title="Send message" aria-label="Send message">
          {#if generating}...{:else}<Icon name="send" size={16} />{/if}
        </button>
      </div>
    </div>
  {/if}
  {/if}
</div>

<style>
  .ai-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    border-left: 1px solid var(--border);
    background: var(--surface-base);
  }

  .ai-panel.minimized {
    justify-content: flex-start;
  }

  .ai-panel.minimized .ai-header {
    border-bottom: none;
  }

  .min-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    padding: 4px 8px;
  }

  .ai-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .mode-tabs {
    display: flex;
    gap: 4px;
  }

  .mode-tabs button {
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-secondary);
  }

  .mode-tabs button.active {
    background: var(--surface-overlay);
    color: var(--accent-primary);
  }

  .header-actions {
    display: flex;
    gap: 4px;
  }

  .toggle-blank {
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    border: 1px solid var(--border-subtle);
  }

  .toggle-blank.active {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .sidecar-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
  }

  .sidecar-toggle.active {
    border-color: var(--accent-green);
    color: var(--accent-green);
  }

  .sidecar-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
  }

  .sidecar-dot.running {
    background: var(--accent-green);
  }

  .close-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
  }

  .close-btn:hover {
    background: var(--surface-raised);
  }

  .header-actions .icon-btn.active {
    background: var(--surface-overlay);
    color: var(--accent-primary);
  }

  .history-dropdown {
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    max-height: 260px;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .history-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .history-new {
    font-size: 12px;
    color: var(--accent-primary);
    text-transform: none;
    letter-spacing: normal;
  }

  .history-list {
    overflow-y: auto;
    padding: 4px 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .history-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    text-align: left;
  }

  .history-item:hover {
    background: var(--surface-overlay);
  }

  .history-item.active {
    background: var(--surface-overlay);
    outline: 1px solid var(--border);
  }

  .history-title {
    font-size: 12px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .history-meta {
    font-size: 11px;
    color: var(--text-muted);
  }

  .history-empty {
    padding: 12px;
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
  }

  .ai-messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .empty-ai {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    gap: 8px;
  }

  .empty-ai .icon {
    font-size: 32px;
    opacity: 0.5;
  }

  .endpoint-hint {
    font-size: 12px;
    color: var(--warning);
    text-align: center;
    max-width: 260px;
  }

  .message {
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
  }

  .message.user {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: var(--text-on-accent);
  }

  .message.generating {
    opacity: 0.7;
    animation: pulse 1.5s infinite;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .cancel-btn {
    opacity: 0.5;
    flex-shrink: 0;
  }
  .cancel-btn:hover {
    opacity: 1;
    color: #ef4444;
  }

  .retry-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: 6px;
    padding: 3px 10px;
    font-size: 11px;
    border-radius: var(--radius-sm);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    cursor: pointer;
  }
  .retry-btn:hover { color: var(--accent-primary); border-color: var(--accent-primary); }
  .retry-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  @keyframes pulse {
    0%, 100% { opacity: 0.7; }
    50% { opacity: 0.4; }
  }

  .role {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .message.user .role {
    color: rgba(255,255,255,0.7);
  }

  .content {
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .writeback-bar {
    display: flex;
    gap: 4px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border-subtle);
  }

  .writeback-bar button,
  .output-actions button {
    padding: 3px 8px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }

  .writeback-bar button:hover,
  .output-actions button:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
    border-color: var(--accent-primary);
  }

  .ai-input {
    padding: 12px;
    border-top: 1px solid var(--border-subtle);
  }

  .context-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    font-size: 11px;
    color: var(--text-secondary);
    margin-bottom: 8px;
  }

  .ws-label {
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--surface-overlay);
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .wb-target {
    display: inline-flex;
    border: 1px solid var(--border-subtle);
    margin: 0 0 8px 8px;
    vertical-align: middle;
  }

  .output-header .wb-target {
    margin: 0;
  }

  .wb-target button {
    padding: 2px 8px;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .wb-target button.active {
    background: var(--surface-overlay);
    color: var(--accent-primary);
  }

  .input-row {
    display: flex;
    gap: 8px;
  }

  textarea {
    flex: 1;
    resize: none;
    font-family: var(--font-mono);
    font-size: 13px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 8px;
    color: var(--text-primary);
  }

  .send-btn {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    background: var(--accent-primary);
    color: var(--text-on-accent);
    font-size: 16px;
    align-self: flex-end;
  }

  .send-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .composer-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 12px;
    gap: 12px;
  }

  .composer-input textarea {
    width: 100%;
    font-family: var(--font-body);
    margin-bottom: 8px;
  }

  .generate-btn {
    padding: 8px 16px;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-size: 13px;
    cursor: pointer;
  }

  .generate-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .composer-output {
    flex: 1;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .output-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 12px;
    color: var(--text-muted);
  }

  .output-actions {
    display: flex;
    gap: 4px;
  }

  .output-content {
    padding: 12px;
    font-size: 13px;
    line-height: 1.6;
    overflow-y: auto;
    max-height: 400px;
    white-space: pre-wrap;
  }

  .ghost-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    padding: 24px;
    text-align: center;
  }

  .ghost-view .icon {
    font-size: 32px;
    margin-bottom: 12px;
    opacity: 0.5;
  }

  .ghost-view p {
    font-size: 13px;
    margin: 4px 0;
  }

  .ghost-status {
    color: var(--accent-primary);
    margin-top: 8px !important;
  }

  .structurize-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 12px;
    gap: 12px;
    overflow-y: auto;
  }

  .structurize-input {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .input-label {
    font-size: 12px;
    color: var(--text-muted);
  }

  .input-label code {
    color: var(--accent-primary);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .structurize-textarea-wrap {
    position: relative;
  }

  .directive-highlight {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 8px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
    pointer-events: none;
    color: transparent;
    border: 1px solid transparent;
    overflow: hidden;
  }

  :global(.directive-highlight .directive) {
    color: var(--accent-primary);
    background: rgba(233, 69, 96, 0.15);
    border-radius: 3px;
    padding: 0 2px;
    font-weight: 600;
  }

  .structurize-textarea-wrap textarea {
    position: relative;
    z-index: 1;
    width: 100%;
    resize: none;
    font-family: var(--font-mono);
    font-size: 13px;
    background: transparent;
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 8px;
    line-height: 1.5;
  }

  .structurize-textarea-wrap textarea:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .structurize-output {
    flex: 1;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
    min-height: 120px;
  }

  .structurize-output .output-content {
    padding: 12px;
    font-size: 13px;
    line-height: 1.6;
    overflow-y: auto;
    max-height: 400px;
    white-space: pre-wrap;
  }

  .action-btn.dismiss {
    color: var(--text-muted);
    border-color: var(--border-subtle);
  }

  .action-btn.dismiss:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }
</style>
