import { invoke, isTauri } from "@tauri-apps/api/core";
import { isWorkspacePrivate } from "$lib/stores/settings";
import { browserInvoke } from "$lib/browserBackend";

/** True when running as a plain web page without the Tauri shell. */
export function isBrowserPreview(): boolean {
  try {
    return !isTauri();
  } catch {
    return true;
  }
}

/**
 * Invoke a backend command. Under Tauri this hits the Rust sidecar;
 * in a plain browser it routes to the localStorage-backed preview backend.
 */
function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isBrowserPreview()) return browserInvoke<T>(cmd, args ?? {});
  return invoke<T>(cmd, args);
}

/**
 * Check if AI call is allowed for the given workspace.
 * Throws if workspace is private (local-only).
 */
export function assertAiAllowed(workspace?: string): void {
  if (workspace && isWorkspacePrivate(workspace)) {
    throw new Error(`AI blocked: "${workspace}" workspace is set to local-only privacy. Toggle it in Settings → Privacy.`);
  }
}

export interface Doc {
  id: string;
  workspace: string;
  kind: string;
  title: string;
  path: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  content: string;
  word_count: number;
  reading_position: number | null;
  status: string;
  frontmatter_json: string | null;
  activity_score: number;
  embedding_ref: string | null;
  pinned?: boolean;
  goal_words?: number | null;
  deadline?: string | null;
  locked?: boolean;
}

export interface Backlink {
  source_id: string;
  target_id: string;
  context_snippet: string;
  source_title: string;
}

export interface SearchResult {
  doc: Doc;
  rank: number;
  snippet: string | null;
}

export interface TabState {
  workspace: string;
  tab_stack_json: string;
  active_id: string | null;
  cursor: string | null;
  scroll: number | null;
}

export interface GraphNode {
  id: string;
  title: string;
  workspace: string;
  kind: string;
  word_count: number;
  activity_score: number;
  degree: number;
  tags?: string[];
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  context_snippet: string | null;
}

export interface GraphQueryResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  orphans: string[];
  hubs: [string, number][];
}

export interface UnlinkedMention {
  source_id: string;
  source_title: string;
  mentioned_title: string;
  context_snippet: string;
}

export interface EntitySummary {
  entity_norm: string;
  display: string;
  kind: string;
  doc_count: number;
  occ_count: number;
}

export interface EntityHit {
  entity_norm: string;
  display: string;
  kind: string;
  doc_id: string;
  doc_title: string;
  span_start: number;
  span_end: number;
  snippet: string;
}

export interface BookshelfEntry {
  doc: Doc;
  shelf_status: string;
  rating: number | null;
}

export interface BibleFact {
  id: string;
  doc_id: string;
  kind: string;
  key: string;
  value: string;
}

export interface BibleMention {
  id: string;
  bible_doc_id: string;
  fact_key: string;
  kind: string;
  doc_id: string;
  doc_title: string;
  snippet: string;
  attribute_key: string | null;
  attribute_value: string | null;
  span_start: number | null;
  created_at: string;
}

export interface BibleSuggestion {
  id: string;
  bible_doc_id: string;
  source_doc_id: string;
  doc_title: string;
  kind: string;
  key: string;
  value: string;
  snippet: string;
  attribute_key: string | null;
  attribute_value: string | null;
  span_start: number | null;
  status: "pending" | "rejected";
  created_at: string;
}

export interface BibleMemoryUpdate {
  skipped: boolean;
  retryable: boolean;
  matched: number;
  suggested: number;
}

export interface BibleMemoryRebuild extends BibleMemoryUpdate {
  processed: number;
}

export interface BeatNode {
  doc: Doc;
  act: number | null;
  sequence: number | null;
  status: string;
  summary: string | null;
  pov: string | null;
  location: string | null;
  timeframe: string | null;
  characters: string[];
}

export interface BeatBoard {
  acts: BeatNode[];
  sequences: BeatNode[];
  scenes: BeatNode[];
}

export interface Conversation {
  id: string;
  doc_id: string | null;
  mode: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface AiGenerateRequest {
  prompt: string;
  system_prompt?: string;
  mode: string;
  workspace?: string;
  provider?: string;
  model?: string;
  max_tokens?: number;
  api_key?: string;
}

export interface AiGenerateResponse {
  content: string;
  tokens_used?: number;
}

export interface StructurizeRequest {
  text: string;
  workspace: string;
  provider?: string;
  model?: string;
  api_key?: string;
}

export interface StructurizeResponse {
  result: string;
  tokens_used?: number;
}

export interface Snapshot {
  id: string;
  doc_id: string;
  label: string;
  content: string | null;
  word_count: number;
  created_at: string;
}

export interface UpdateStatus {
  configured: boolean;
  endpoint: string | null;
}

export interface ConvertOutput {
  filename: string;
  mime: string;
  base64: string;
}

export interface ConvertStatus {
  pandoc: boolean;
  bundled: boolean;
  formats: string[];
}

export interface GhostGroup {
  original: Doc;
  ghosts: Doc[];
}

export interface AtlasStar {
  id: string;
  title: string;
  workspace: string;
  word_count: number;
  activity_score: number;
  updated_at: string;
  embedding: number[];
}

export interface CanvasNode {
  id: string;
  title: string;
  body: string;
  x: number;
  y: number;
  color: string;
  doc_id: string | null;
  updated_at: string;
}

export interface CanvasEdge {
  id: string;
  source_id: string;
  target_id: string;
  label: string;
}

export interface RagChunk {
  id: string;
  doc_id: string;
  chunk_index: number;
  content: string;
  start_word: number;
  end_word: number;
}

export const api = {
  docCreate: (workspace: string, kind: string, title: string, parentId?: string, content?: string, frontmatterJson?: string) =>
    safeInvoke<Doc>("doc_create", { workspace, kind, title, parentId, content, frontmatterJson }),

  openExternalFile: (path: string) =>
    safeInvoke<Doc | null>("open_external_file", { path }),

  takeLaunchFile: () =>
    safeInvoke<string | null>("take_launch_file"),

  openDefaultApps: () =>
    safeInvoke<void>("open_default_apps"),

  docGet: (id: string) =>
    safeInvoke<Doc>("doc_get", { id }),

  docSave: (id: string, title?: string, content?: string, status?: string, frontmatterJson?: string, parentId?: string | null) =>
    safeInvoke<Doc>("doc_save", { id, title, content, status, frontmatterJson, parentId }),

  docDelete: (id: string) =>
    safeInvoke<void>("doc_delete", { id }),

  docMove: (id: string, newParentId?: string, newPath?: string) =>
    safeInvoke<Doc>("doc_move", { id, newParentId, newPath }),

  docTogglePin: (id: string) =>
    safeInvoke<boolean>("doc_toggle_pin", { id }),

  docSetGoal: (id: string, goalWords?: number, deadline?: string) =>
    safeInvoke<void>("doc_set_goal", { id, goalWords, deadline }),

  docSearch: (query: string, workspace?: string) =>
    safeInvoke<SearchResult[]>("doc_search", { query, workspace }),

  docListByWorkspace: (workspace: string) =>
    safeInvoke<Doc[]>("doc_list_by_workspace", { workspace }),

  backlinksGet: (docId: string) =>
    safeInvoke<Backlink[]>("backlinks_get", { docId }),

  implicitLinksGet: (docId: string) =>
    safeInvoke<{ source_id: string; target_id: string; match_type: string }[]>("implicit_links_get", { docId }),

  usageRecord: (docId: string, event: string) =>
    safeInvoke<void>("usage_record", { docId, event }),

  tabsGet: (workspace: string) =>
    safeInvoke<TabState | null>("tabs_get", { workspace }),

  tabsSet: (state: TabState) =>
    safeInvoke<void>("tabs_set", { state }),

  logGetOrCreate: (date: string) =>
    safeInvoke<Doc>("log_get_or_create", { date }),

  logListEntries: (limit?: number) =>
    safeInvoke<Doc[]>("log_list_entries", { limit }),

  graphQuery: (params?: { workspace?: string; tags?: string[] }) =>
    safeInvoke<GraphQueryResult>("graph_query", params ?? {}),

  backlinksExtract: (docId: string) =>
    safeInvoke<void>("backlinks_extract", { docId }),

  unlinkedMentions: (docId: string) =>
    safeInvoke<UnlinkedMention[]>("unlinked_mentions", { docId }),

  entitiesList: () =>
    safeInvoke<EntitySummary[]>("entities_list", {}),

  entityOccurrences: (entityNorm: string) =>
    safeInvoke<EntityHit[]>("entity_occurrences", { entityNorm }),

  entitiesBackfill: () =>
    safeInvoke<number>("entities_backfill", {}),

  readerUpdatePosition: (docId: string, position: number) =>
    safeInvoke<void>("reader_update_position", { docId, position }),

  readerSetShelfStatus: (docId: string, status: string) =>
    safeInvoke<void>("reader_set_shelf_status", { docId, status }),

  readerSetRating: (docId: string, rating: number | null) =>
    safeInvoke<void>("reader_set_rating", { docId, rating }),

  readerGetBookshelf: (filter?: string) =>
    safeInvoke<BookshelfEntry[]>("reader_get_bookshelf", { filter }),

  readerImportBook: (title: string, content: string, kind: string) =>
    safeInvoke<Doc>("reader_import_book", { title, content, kind }),

  novelGetBeatBoard: (projectId: string) =>
    safeInvoke<BeatBoard>("novel_get_beat_board", { projectId }),

  novelCompile: (projectId: string) =>
    safeInvoke<string>("novel_compile", { projectId }),

  bibleScopeId: (docId: string) =>
    safeInvoke<string>("bible_scope_id", { docId }),

  bibleGetFacts: (docId: string) =>
    safeInvoke<BibleFact[]>("bible_get_facts", { docId }),

  bibleUpsertFact: (docId: string, kind: string, key: string, value: string) =>
    safeInvoke<BibleFact>("bible_upsert_fact", { docId, kind, key, value }),

  bibleDeleteFact: (factId: string) =>
    safeInvoke<void>("bible_delete_fact", { factId }),

  bibleGetMentions: (bibleDocId: string) =>
    safeInvoke<BibleMention[]>("bible_get_mentions", { bibleDocId }),

  bibleUpsertMention: (bibleDocId: string, docId: string, factKey: string, kind: string, snippet: string, attributeKey?: string | null, attributeValue?: string | null) =>
    safeInvoke<BibleMention>("bible_upsert_mention", { bibleDocId, docId, factKey, kind, snippet, attributeKey, attributeValue }),

  bibleDeleteMentions: (bibleDocId: string, docId?: string, factKey?: string) =>
    safeInvoke<void>("bible_delete_mentions", { bibleDocId, docId, factKey }),

  bibleGetSuggestions: (bibleDocId: string) =>
    safeInvoke<BibleSuggestion[]>("bible_get_suggestions", { bibleDocId }),

  bibleConfirmSuggestion: (bibleDocId: string, suggestionId: string) =>
    safeInvoke<BibleFact>("bible_confirm_suggestion", { bibleDocId, suggestionId }),

  bibleRejectSuggestion: (bibleDocId: string, suggestionId: string) =>
    safeInvoke<void>("bible_reject_suggestion", { bibleDocId, suggestionId }),

  bibleExtractMentions: (docId: string, expectedContent: string) =>
    safeInvoke<BibleMemoryUpdate>("bible_extract_mentions", { docId, expectedContent }),

  bibleRebuildMemory: (projectId: string) =>
    safeInvoke<BibleMemoryRebuild>("bible_rebuild_memory", { projectId }),

  conversationCreate: (docId?: string, mode?: string) =>
    safeInvoke<Conversation>("conversation_create", { docId, mode }),

  conversationList: () =>
    safeInvoke<Conversation[]>("conversation_list"),

  conversationAddMessage: (conversationId: string, role: string, content: string) =>
    safeInvoke<ChatMessage>("conversation_add_message", { conversationId, role, content }),

  conversationGetMessages: (conversationId: string) =>
    safeInvoke<ChatMessage[]>("conversation_get_messages", { conversationId }),

  aiGenerate: (request: AiGenerateRequest) => {
    assertAiAllowed(request.workspace);
    return safeInvoke<AiGenerateResponse>("ai_generate", { request });
  },

  /**
   * Streaming generation: `onToken` fires per delta, resolves with the
   * full text. Browser preview falls back to one shot + one callback via
   * the "ai_generate" case — this alias is intentional (no separate
   * "ai_generate_stream" browser case exists, and the api ⊆ backend
   * invariant check must keep allowing it).
   */
  aiGenerateStream: async (request: AiGenerateRequest, onToken: (token: string) => void): Promise<string> => {
    assertAiAllowed(request.workspace);
    if (isBrowserPreview()) {
      const res = await browserInvoke<AiGenerateResponse>("ai_generate", { request });
      if (res.content) onToken(res.content);
      return res.content;
    }
    const { Channel } = await import("@tauri-apps/api/core");
    let full = "";
    const channel = new Channel<string>((token) => {
      full += token;
      onToken(token);
    });
    await invoke<void>("ai_generate_stream", { request, onEvent: channel });
    return full;
  },

  aiStructurize: (request: StructurizeRequest) => {
    assertAiAllowed(request.workspace);
    return safeInvoke<StructurizeResponse>("ai_structurize", { request });
  },

  perfBenchmark: () =>
    safeInvoke<{ doc_count: number; snapshot_count: number; edge_count: number; rag_chunk_count: number; search_latency_us: number; snapshot_latency_us: number }>("perf_benchmark"),

  fsListDir: (path: string) =>
    safeInvoke<[string, boolean, number][]>("fs_list_dir", { path }),

  fsReadFile: (path: string) =>
    safeInvoke<string>("fs_read_file", { path }),

  fsRename: (oldPath: string, newName: string) =>
    safeInvoke<string>("fs_rename", { oldPath, newName }),

  fsDelete: (path: string) =>
    safeInvoke<void>("fs_delete", { path }),

  fsMove: (src: string, destDir: string) =>
    safeInvoke<string>("fs_move", { src, destDir }),

  fsCreateDir: (path: string) =>
    safeInvoke<void>("fs_create_dir", { path }),

  fsWriteFile: (path: string, contents: string) =>
    safeInvoke<void>("fs_write_file", { path, contents }),

  /**
   * Save a dropped/pasted attachment into `<vault>/.attachments/`.
   * Resolves to the vault-relative ref (`.attachments/<name>`) for the doc.
   * Throws in the browser preview (no vault files) — callers fall back.
   */
  attachmentSave: (filename: string, base64Data: string) =>
    safeInvoke<string>("attachment_save", { filename, base64Data }),

  /** Binary-safe vault attachment read for export bundling. */
  attachmentRead: (path: string) =>
    safeInvoke<string>("attachment_read", { path }),

  /** Reveal in the OS file manager (desktop shell only — throws in preview). */
  fsReveal: (path: string) =>
    safeInvoke<void>("fs_reveal", { path }),

  memoryDecayActivity: () =>
    safeInvoke<number>("memory_decay_activity"),

  memorySmartTabs: (workspace: string) =>
    safeInvoke<Doc[]>("memory_smart_tabs", { workspace }),

  memoryRecordMetric: (docId: string, metricType: string, value: number) =>
    safeInvoke<void>("memory_record_metric", { docId, metricType, value }),

  memoryGetMetrics: (docId: string) =>
    safeInvoke<[string, number, string][]>("memory_get_metrics", { docId }),

  craftMetricsTrend: (docId: string, metricType: string) =>
    safeInvoke<[string, number][]>("craft_metrics_trend", { docId, metricType }),

  dashboardRecentDocs: (limit: number) =>
    safeInvoke<[string, string, string][]>("dashboard_recent_docs", { limit }),

  dashboardWorkspaceCounts: () =>
    safeInvoke<[string, number][]>("dashboard_workspace_counts"),

  dashboardWritingDays: () =>
    safeInvoke<string[]>("dashboard_writing_days"),

  dashboardPatterns: () =>
    safeInvoke<{ peak_hour: string | null; most_active_workspace: { workspace: string; this_week: number; last_week: number } | null; momentum: number; avg_session_minutes: number }>("dashboard_patterns"),

  dashboardGoals: () =>
    safeInvoke<{ id: string; title: string; workspace: string; goal_words: number; word_count: number; deadline: string | null }[]>("dashboard_goals"),

  // Usage Memory (8.3)
  getReopenNeverFinish: () =>
    safeInvoke<Array<{ doc: Doc; openCount: number; lastOpened: string }>>("get_reopen_never_finish"),
  dashboardStreakHeatmap: () =>
    safeInvoke<{ date: string; words: number }[]>("dashboard_streak_heatmap"),
  dashboardWritingTimePatterns: () =>
    safeInvoke<{ hour: number; count: number }[]>("dashboard_writing_time_patterns"),

  vaultRenamePreview: (oldTitle: string) =>
    safeInvoke<[string, string, string][]>("vault_rename_preview", { oldTitle }),

  vaultRenameExecute: (oldTitle: string, newTitle: string) =>
    safeInvoke<number>("vault_rename_execute", { oldTitle, newTitle }),

  atomicSave: (docId: string, body: string) =>
    safeInvoke<void>("atomic_save", { docId, body }),

  setupFileWatcher: () =>
    safeInvoke<void>("setup_file_watcher"),

  sidecarStart: (pythonPath: string, harnessDir: string) =>
    safeInvoke<void>("sidecar_start", { pythonPath, harnessDir }),

  sidecarPythonProbe: (pythonPath: string) =>
    safeInvoke<string>("sidecar_python_probe", { pythonPath }),

  sidecarStop: () =>
    safeInvoke<void>("sidecar_stop"),

  sidecarIsRunning: () =>
    safeInvoke<boolean>("sidecar_is_running"),

  sidecarSetEndpoint: (endpoint: string) =>
    safeInvoke<void>("sidecar_set_endpoint", { endpoint }),

  sidecarQuery: (prompt: string, sessionId: string) =>
    safeInvoke<{ response: string; confidence: number; escalated: boolean; tool_used: string | null }>(
      "sidecar_query", { prompt, sessionId }
    ),

  memoryGetStreak: () =>
    safeInvoke<[number, number]>("memory_get_streak"),

  docSearchFull: (query: string, workspace?: string) =>
    safeInvoke<SearchResult[]>("doc_search_full", { query, workspace }),

  docGetStats: () =>
    safeInvoke<[number, number, number]>("doc_get_stats"),

  snapshotCreate: (docId: string) =>
    safeInvoke<Snapshot>("snapshot_create", { docId }),

  snapshotList: (docId: string) =>
    safeInvoke<Snapshot[]>("snapshot_list", { docId }),

  snapshotRestore: (snapshotId: string) =>
    safeInvoke<Doc>("snapshot_restore", { snapshotId }),

  snapshotDeleteOld: (retentionDays: number) =>
    safeInvoke<number>("snapshot_delete_old", { retentionDays }),

  backupCreate: () =>
    safeInvoke<string>("backup_create"),

  backupList: () =>
    safeInvoke<[string, string, number][]>("backup_list"),

  ragChunkDocument: (docId: string, chunkSize?: number, overlap?: number) =>
    safeInvoke<RagChunk[]>("rag_chunk_document", { docId, chunkSize, overlap }),

  ragSearch: (query: string, limit?: number) =>
    safeInvoke<[RagChunk, number][]>("rag_search", { query, limit }),

  ragGetContext: (docId: string, query: string, maxChunks?: number) =>
    safeInvoke<string>("rag_get_context", { docId, query, maxChunks }),

  clearConversations: () =>
    safeInvoke<number>("clear_conversations"),

  clearMessages: () =>
    safeInvoke<number>("clear_messages"),

  clearSnapshots: () =>
    safeInvoke<number>("clear_snapshots"),

  clearUsageEvents: () =>
    safeInvoke<number>("clear_usage_events"),

  clearTabStates: () =>
    safeInvoke<number>("clear_tab_states"),

  getWorkspaceContext: (docId: string, workspace: string) =>
    safeInvoke<string>("get_workspace_context", { docId, workspace }),

  getVaultPath: () =>
    safeInvoke<string>("get_vault_path"),

  // ── STT: Moonshine Voice ──────────────────────────────────────
  sttStart: (pythonPath: string, sidecarsDir: string, model?: string) =>
    safeInvoke<void>("stt_start", { pythonPath, sidecarsDir, model }),

  sttStop: () =>
    safeInvoke<void>("stt_stop"),

  sttIsRunning: () =>
    safeInvoke<boolean>("stt_is_running"),

  sttHealth: () =>
    safeInvoke<{ status: string; model_loaded: boolean; model?: string }>("stt_health"),

  sttPort: () =>
    safeInvoke<number>("stt_port"),

  sttTranscribe: (audio: string, format: string) =>
    safeInvoke<string>("stt_transcribe", { audio, format }),

  sttStreamStart: () =>
    safeInvoke<void>("stt_stream_start"),

  sttStreamChunk: (audio: string, format: string) =>
    safeInvoke<void>("stt_stream_chunk", { audio, format }),

  sttStreamStop: () =>
    safeInvoke<string>("stt_stream_stop"),

  // ── TTS: Kokoro-82M ──────────────────────────────────────────
  ttsStart: (pythonPath: string, sidecarsDir: string, model?: string) =>
    safeInvoke<void>("tts_start", { pythonPath, sidecarsDir, model }),

  ttsStop: () =>
    safeInvoke<void>("tts_stop"),

  ttsIsRunning: () =>
    safeInvoke<boolean>("tts_is_running"),

  ttsHealth: () =>
    safeInvoke<{ status: string; model_loaded: boolean }>("tts_health"),

  ttsPort: () =>
    safeInvoke<number>("tts_port"),

  ttsSynthesize: (text: string, voice: string, speed: number, langCode: string, splitPattern: string, chunkSize: number) =>
    safeInvoke<[string, number]>("tts_synthesize", { text, voice, speed, langCode, splitPattern, chunkSize }),

  ttsStopPlayback: () =>
    safeInvoke<void>("tts_stop_playback"),

  // ── LLM: llama.cpp server (LFM 2.5-350M) ───────────────────────────
  llmStart: (sidecarsDir: string, model?: string, ctxSize?: number) =>
    safeInvoke<void>("llm_start", { sidecarsDir, model, ctxSize }),

  llmStop: () =>
    safeInvoke<void>("llm_stop"),

  llmIsRunning: () =>
    safeInvoke<boolean>("llm_is_running"),

  llmHealth: () =>
    safeInvoke<{ status: string; model?: string }>("llm_health"),

  llmPort: () =>
    safeInvoke<number>("llm_port"),

  llmCompletion: (prompt: string, maxTokens: number, temperature: number) =>
    safeInvoke<string>("llm_completion", { prompt, maxTokens, temperature }),

  llmChatCompletion: (messages: any[], maxTokens: number, temperature: number) =>
    safeInvoke<string>("llm_chat_completion", { messages, maxTokens, temperature }),

  appUpdateStatus: () =>
    safeInvoke<UpdateStatus>("app_update_status"),

  convertRun: (docId: string, outFmt: string) =>
    safeInvoke<ConvertOutput>("convert_run", { docId, outFmt }),

  compileRun: (docIds: string[], outFmt: string, title?: string) =>
    safeInvoke<ConvertOutput>("compile_run", { docIds, outFmt, title }),

  convertStatus: () =>
    safeInvoke<ConvertStatus>("convert_status"),

  docSetLocked: (id: string, locked: boolean) =>
    safeInvoke<void>("doc_set_locked", { id, locked }),

  docListPinned: () =>
    safeInvoke<Doc[]>("doc_list_pinned"),

  dashboardTodayRhythm: () =>
    safeInvoke<[number, number][]>("dashboard_today_rhythm"),

  canvasList: () =>
    safeInvoke<[CanvasNode[], CanvasEdge[]]>("canvas_list"),

  canvasUpsertNode: (node: CanvasNode) =>
    safeInvoke<CanvasNode>("canvas_upsert_node", { node }),

  canvasDeleteNode: (id: string) =>
    safeInvoke<void>("canvas_delete_node", { id }),

  canvasConnect: (sourceId: string, targetId: string, label: string) =>
    safeInvoke<CanvasEdge>("canvas_connect", { sourceId, targetId, label }),

  canvasDeleteEdge: (id: string) =>
    safeInvoke<void>("canvas_delete_edge", { id }),

  // ── AI memory sidecar (vendored harness) ────────────────────────
  memorySidecarStart: (pythonPath: string, sidecarsDir: string) =>
    safeInvoke<void>("memory_sidecar_start", { pythonPath, sidecarsDir }),

  memorySidecarStop: () =>
    safeInvoke<void>("memory_sidecar_stop"),

  memorySidecarRunning: () =>
    safeInvoke<boolean>("memory_sidecar_running"),

  memorySidecarHealth: () =>
    safeInvoke<{ status: string; facts: number }>("memory_sidecar_health"),

  memoryLearn: (text: string) =>
    safeInvoke<number>("memory_learn", { text }),

  memoryRecall: (query: string) =>
    safeInvoke<string>("memory_recall", { query }),

  memoryRedact: (text: string) =>
    safeInvoke<string>("memory_redact", { text }),

  memoryForgetAll: () =>
    safeInvoke<void>("memory_forget_all"),

  // ── Publish: Static site generation ───────────────────────────────
  publishStaticSite: (config: Record<string, unknown>) =>
    safeInvoke<{ indexHtml: string; files: string[]; imagesInlined?: number; imagesSkipped?: number }>("publish_static_site", { config }),

  // ── Import/Export ────────────────────────────────────────────────
// Telemetry/Analytics (only commands with live callers stay surfaced)
  dashboardProductivityScore: () =>
    safeInvoke<{ score: number; totalWords: number; totalDocs: number; activeDays: number; avgWords: number }>("dashboard_productivity_score"),
  dashboardWritingVelocity: () =>
    safeInvoke<{ date: string; words: number }[]>("dashboard_writing_velocity"),

  // Role Assignment for Scripts
  scriptRoleList: (docId: string) =>
    safeInvoke<Array<{ id: string; name: string; color: string; assignedTo: string }>>("script_role_list", { docId }),
  scriptRoleAssign: (docId: string, roleId: string, assignedTo: string) =>
    safeInvoke<{ success: boolean }>("script_role_assign", { docId, roleId, assignedTo }),
  scriptRoleCreate: (docId: string, name: string, color: string, assignedTo?: string) =>
    safeInvoke<{ role: { id: string; name: string; color: string; assignedTo: string } }>("script_role_create", { docId, name, color, assignedTo }),
  scriptRoleDelete: (docId: string, roleId: string) =>
    safeInvoke<{ success: boolean }>("script_role_delete", { docId, roleId }),

  // Script-specific features
  scriptCharacterList: (docId: string) =>
    safeInvoke<string[]>("script_character_list", { docId }),
  scriptCharacterAdd: (docId: string, name: string) =>
    safeInvoke<{ success: boolean }>("script_character_add", { docId, name }),
  scriptLocationList: (docId: string) =>
    safeInvoke<string[]>("script_location_list", { docId }),
  scriptLocationAdd: (docId: string, name: string) =>
    safeInvoke<{ success: boolean }>("script_location_add", { docId, name }),
  scriptTimelineGet: (docId: string) =>
    safeInvoke<Array<{ event: string; date: string; act: number }>>("script_timeline_get", { docId }),
  scriptTimelineAdd: (docId: string, event: string, date: string, act: number) =>
    safeInvoke<{ success: boolean }>("script_timeline_add", { docId, event, date, act }),

  // Ghosts (scene forking)
  ghostFork: (docId: string, label?: string) =>
    safeInvoke<Doc>("ghost_fork", { docId, label }),
  ghostList: (docId: string) =>
    safeInvoke<GhostGroup>("ghost_list", { docId }),
  ghostMerge: (ghostId: string, targetId?: string) =>
    safeInvoke<Doc>("ghost_merge", { ghostId, targetId }),
  ghostDismiss: (ghostId: string) =>
    safeInvoke<void>("ghost_dismiss", { ghostId }),

  // Atlas (star-sky memory)
  atlasGetStars: () =>
    safeInvoke<AtlasStar[]>("atlas_get_stars"),

  // ── OS keychain secrets (never persisted to localStorage) ──────
  secretSet: (key: "apiKey" | "appLockPin", value: string) =>
    safeInvoke<void>("secret_set", { key, value }),

  secretGet: (key: "apiKey" | "appLockPin") =>
    safeInvoke<string | null>("secret_get", { key }),

};
