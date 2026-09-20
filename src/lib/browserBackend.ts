/**
 * browserBackend — dispatches Tauri command names to the in-browser store.
 *
 * Used only when the app runs as a plain web page (no Tauri IPC). The real
 * desktop/Android app keeps using the Rust backend; this module is the
 * preview companion so every workspace is explorable in a browser.
 */

import { browserStore, countWords, type BrowserCanvasNode, type BrowserDoc } from "$lib/browserStore";

function frontmatter(doc: BrowserDoc): Record<string, unknown> {
  if (!doc.frontmatter_json) return {};
  try {
    return JSON.parse(doc.frontmatter_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function docShape(d: BrowserDoc): BrowserDoc {
  return { ...d };
}

async function aiChatCompletions(provider: string | undefined, model: string | undefined, prompt: string, system?: string, apiKey?: string): Promise<string> {
  const base = (provider || "").replace(/\/$/, "");
  if (!/^https?:\/\//.test(base)) {
    throw new Error("AI needs the desktop app or a reachable local endpoint (set one in Settings → AI & Providers).");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model || "llama3.2",
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI endpoint returned ${res.status}. Is the model server running with CORS enabled?`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("AI endpoint returned an empty response.");
  return text;
}

/** Deterministic local structurize: headings from {directives}, content preserved. */
function localStructurize(text: string): string {
  const directiveRe = /\{([^}]+)\}/g;
  const directives: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = directiveRe.exec(text)) !== null) directives.push(m[1].trim());
  const body = text.replace(directiveRe, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (directives.length === 0) {
    return ["# Structured Draft", "", ...body].join("\n");
  }
  const lines: string[] = ["# Structured Draft", ""];
  let bi = 0;
  for (const d of directives) {
    lines.push(`## ${d.charAt(0).toUpperCase()}${d.slice(1)}`, "");
    // Deal one content chunk per directive so nothing is silently dropped.
    if (bi < body.length) {
      const take = Math.max(1, Math.ceil(body.length / directives.length));
      lines.push(...body.slice(bi, bi + take), "");
      bi += take;
    }
  }
  if (bi < body.length) lines.push("## Remaining", "", ...body.slice(bi));
  return lines.join("\n").trimEnd();
}

function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function markdownToText(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      let l = line.replace(/^(#{1,6}|>)\s*/, "").replace(/^(\s*[-*]\s(\[[ x]\]\s)?|\s*\d+\.\s)/, "");
      l = l.replace(/(\*\*|__)(.*?)\1/g, "$2").replace(/(`|\*)(.*?)\1/g, "$2");
      l = l.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
      return l.trim() === "---" || l.trim() === "***" ? "" : l;
    })
    .join("\n");
}

function markdownToHtmlDoc(title: string, md: string): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = esc(md)
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .split("\n\n")
    .map((p) => (/^<h\d>/.test(p.trim()) ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`))
    .join("\n");
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${esc(title)}</title>\n<style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:20px;line-height:1.8;color:#333}\nh1,h2,h3{margin-top:2em}pre{background:#f5f5f5;padding:12px;overflow-x:auto}</style>\n</head><body>${body}</body></html>`;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Built-in browser conversions (md/txt/html). Pandoc formats need the desktop app. */
function convertMarkdown(title: string, markdown: string, outFmt: string): { filename: string; mime: string; base64: string } {
  const enc = new TextEncoder();
  const slug = slugify(title);
  if (outFmt === "md") {
    return { filename: `${slug}.md`, mime: "text/markdown", base64: toBase64(enc.encode(markdown)) };
  }
  if (outFmt === "txt") {
    return { filename: `${slug}.txt`, mime: "text/plain", base64: toBase64(enc.encode(markdownToText(markdown))) };
  }
  if (outFmt === "html") {
    return { filename: `${slug}.html`, mime: "text/html", base64: toBase64(enc.encode(markdownToHtmlDoc(title, markdown))) };
  }
  throw new Error(`The .${outFmt} format needs pandoc in the desktop app. See docs/EXPORT.md.`);
}

export const FILTER_WORDS = [
  "very", "really", "just", "quite", "rather", "somewhat", "somehow",
  "actually", "basically", "literally", "suddenly", "quickly", "slowly",
  "seemed", "felt", "looked", "appeared", "began", "started", "continued",
  "that", "then", "so", "well", "even", "still", "almost", "nearly",
];

export function filterWordRatio(content: string): number {
  const words = content.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length === 0) return 0;
  const hits = words.filter((w) => FILTER_WORDS.includes(w)).length;
  return Math.round((hits / words.length) * 1000) / 1000;
}

function craftStats(content: string): { dialogue: number; avgSentence: number; filterWords: number } {
  const dialogueLines = content.split("\n").filter((l) => /^\s*["“—-]/.test(l)).length;
  const totalLines = Math.max(1, content.split("\n").filter((l) => l.trim()).length);
  const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = countWords(content);
  return {
    dialogue: Math.round((dialogueLines / totalLines) * 100) / 100,
    avgSentence: sentences.length > 0 ? Math.round((words / sentences.length) * 10) / 10 : 0,
    filterWords: filterWordRatio(content),
  };
}

/** Every Tauri command the frontend can invoke, implemented for the browser. */
export async function browserInvoke<T>(cmd: string, payload: Record<string, unknown>): Promise<T> {
  const store = browserStore;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

  switch (cmd) {
    case "doc_create":
      return docShape(store.create(
        String(payload.workspace), String(payload.kind), String(payload.title ?? "Untitled"),
        str(payload.parentId), str(payload.content), str(payload.frontmatterJson),
      )) as T;

    case "doc_get":
      return docShape(store.get(String(payload.id))) as T;

    case "doc_save": {
      const patch: Record<string, unknown> = {};
      if (payload.title !== undefined) patch.title = payload.title;
      if (payload.content !== undefined) patch.content = payload.content;
      if (payload.status !== undefined) patch.status = payload.status;
      if (payload.frontmatterJson !== undefined) patch.frontmatter_json = payload.frontmatterJson;
      if (payload.parentId !== undefined) patch.parent_id = payload.parentId;
      return docShape(store.saveDoc(String(payload.id), patch)) as T;
    }

    case "atomic_save":
      return docShape(store.saveDoc(String(payload.docId), { content: String(payload.body) })) as T;

    case "doc_delete":
      store.delete(String(payload.id));
      return undefined as T;

    case "doc_move": {
      const patch: Record<string, unknown> = {};
      if (payload.newParentId !== undefined) patch.parent_id = payload.newParentId;
      if (payload.newPath !== undefined) patch.path = payload.newPath;
      return docShape(store.saveDoc(String(payload.id), patch)) as T;
    }

    case "doc_toggle_pin": {
      const doc = store.get(String(payload.id));
      const pinned = !doc.pinned;
      store.saveDoc(doc.id, { pinned });
      return pinned as T;
    }

    case "doc_set_goal": {
      const patch: Record<string, unknown> = {};
      if (payload.goalWords !== undefined) patch.goal_words = payload.goalWords;
      if (payload.deadline !== undefined) patch.deadline = payload.deadline;
      store.saveDoc(String(payload.id), patch);
      return undefined as T;
    }

    case "doc_search":
    case "doc_search_full":
      return store.search(String(payload.query ?? ""), str(payload.workspace)) as T;

    case "doc_list_by_workspace":
      return store.listByWorkspace(String(payload.workspace)) as T;

    case "doc_get_stats": {
      const words = store.docs.reduce((n, d) => n + d.word_count, 0);
      let links = 0;
      for (const d of store.docs) links += store.outgoingLinks(d).length;
      return [store.docs.length, words, links] as T;
    }

    case "backlinks_get":
      return store.backlinksFor(String(payload.docId)) as T;

    case "backlinks_extract":
      return undefined as T; // links derive on read in the browser store

    case "graph_query": {
      const ws = String(payload.workspace ?? "all");
      const tags = Array.isArray(payload.tags) ? payload.tags : [];
      let nodes = store.docs.map((d) => ({
        id: d.id,
        title: d.title,
        workspace: d.workspace,
        kind: d.kind,
        word_count: d.word_count,
        activity_score: d.activity_score,
        degree: store.outgoingLinks(d).length,
        tags: d.frontmatter_json ? (JSON.parse(d.frontmatter_json).tags ?? []) : [],
      }));
      if (ws !== "all") nodes = nodes.filter((n) => n.workspace === ws);
      if (tags.length > 0) nodes = nodes.filter((n) => n.tags && tags.every((t) => n.tags!.includes(t)));
      const edges = store.docs.flatMap((d) => store.outgoingLinks(d).map((l) => ({ source: d.id, target: l.targetId, kind: l.kind, context_snippet: l.context || "" })));
      return { nodes, edges, orphans: [], hubs: [] } as T;
    }

    case "unlinked_mentions":
      return store.unlinkedMentions(String(payload.docId)) as T;

    case "usage_record":
      store.recordUsage(String(payload.docId), String(payload.event ?? "open"));
      return undefined as T;

    case "doc_set_locked":
      store.setLocked(String(payload.id), Boolean(payload.locked));
      return undefined as T;

    case "doc_list_pinned":
      return store.listPinned() as T;

    // AI memory sidecar needs desktop python — never silently pass through.
    case "memory_sidecar_start":
    case "memory_sidecar_stop":
      return undefined as T;

    case "memory_sidecar_running":
      return false as T;

    case "memory_sidecar_health":
    case "memory_learn":
    case "memory_recall":
    case "memory_redact":
    case "memory_forget_all":
      throw new Error("AI memory needs the desktop app's memory sidecar.");

    case "canvas_list": {
      const board = store.canvasList();
      return [board.nodes, board.edges] as T;
    }

    case "canvas_upsert_node":
      return store.canvasUpsertNode(payload.node as BrowserCanvasNode) as T;

    case "canvas_delete_node":
      store.canvasDeleteNode(String(payload.id));
      return undefined as T;

    case "canvas_connect":
      return store.canvasConnect(String(payload.sourceId), String(payload.targetId), String(payload.label ?? "")) as T;

    case "canvas_delete_edge":
      store.canvasDeleteEdge(String(payload.id));
      return undefined as T;

    case "dashboard_today_rhythm":
      return store.todayRhythm() as T;

    case "tabs_get": {
      const t = store.tabs[String(payload.workspace)];
      return (t ? { workspace: payload.workspace, ...t, cursor: null, scroll: null } : null) as T;
    }

    case "tabs_set": {
      const s = payload.state as { workspace: string; tab_stack_json: string; active_id: string | null };
      store.tabs[s.workspace] = { tab_stack_json: s.tab_stack_json, active_id: s.active_id };
      try {
        localStorage.setItem("jwe-browser-tabs-v1", JSON.stringify(store.tabs));
      } catch {
        /* ignore */
      }
      return undefined as T;
    }

    case "log_get_or_create": {
      const date = String(payload.date);
      const existing = store.docs.find((d) => d.workspace === "logs" && d.title === date);
      if (existing) return docShape(existing) as T;
      return docShape(store.create("logs", "log", date, undefined, `# ${date}\n\n`)) as T;
    }

    case "log_list_entries":
      return store.listByWorkspace("logs").slice(0, num(payload.limit) ?? 60) as T;

    case "reader_update_position":
      store.saveDoc(String(payload.docId), { reading_position: num(payload.position) ?? 0 });
      return undefined as T;

    case "reader_set_shelf_status":
      store.saveDoc(String(payload.docId), { shelf_status: String(payload.status) });
      return undefined as T;

    case "reader_set_rating":
      store.saveDoc(String(payload.docId), { rating: (payload.rating as number | null) ?? null });
      return undefined as T;

    case "reader_get_bookshelf": {
      const books = store.listByWorkspace("reader").map((d) => ({
        doc: d,
        shelf_status: d.shelf_status ?? "to-read",
        rating: d.rating ?? null,
      }));
      const filter = str(payload.filter);
      return (filter && filter !== "all" ? books.filter((b) => b.shelf_status === filter) : books) as T;
    }

    case "reader_import_book":
      return docShape(store.create("reader", String(payload.kind ?? "md"), String(payload.title), undefined, String(payload.content ?? ""))) as T;

    case "novel_get_beat_board": {
      const projectId = String(payload.projectId);
      const chapters = store.docs.filter((d) => d.workspace === "novel" && (d.parent_id === projectId || d.id === projectId));
      const toNode = (d: BrowserDoc) => {
        const fm = frontmatter(d);
        return {
          doc: docShape(d),
          act: typeof fm.act === "number" ? fm.act : null,
          sequence: typeof fm.sequence === "number" ? fm.sequence : null,
          status: d.status,
          summary: typeof fm.summary === "string" ? fm.summary : null,
          pov: typeof fm.pov === "string" ? fm.pov : null,
          location: typeof fm.location === "string" ? fm.location : null,
          timeframe: typeof fm.timeframe === "string" ? fm.timeframe : null,
          characters: Array.isArray(fm.characters) ? fm.characters : [],
        };
      };
      const fmOrder = (d: BrowserDoc): number => {
        const o = frontmatter(d).order;
        return typeof o === "number" ? o : 0;
      };
      const byCreated = (a: BrowserDoc, b: BrowserDoc): number => +new Date(a.created_at) - +new Date(b.created_at);
      const nodes = chapters.map(toNode);
      // Board arrangement = compile order (same sort as the Rust backend).
      const acts = nodes.filter((n) => n.act !== null && n.sequence === null)
        .sort((a, b) => fmOrder(a.doc) - fmOrder(b.doc) || byCreated(a.doc, b.doc));
      const sequences = nodes.filter((n) => n.sequence !== null)
        .sort((a, b) => (a.act ?? 0) - (b.act ?? 0) || fmOrder(a.doc) - fmOrder(b.doc) || byCreated(a.doc, b.doc));
      const scenes = nodes.filter((n) => n.act === null && n.sequence === null)
        .sort((a, b) => fmOrder(a.doc) - fmOrder(b.doc) || byCreated(a.doc, b.doc));
      return { acts, sequences, scenes } as T;
    }

    case "novel_compile": {
      const projectId = String(payload.projectId);
      const chapters = store.docs
        .filter((d) => d.workspace === "novel" && (d.parent_id === projectId || d.id === projectId));
      const fmOrder = (d: BrowserDoc): number => {
        const o = frontmatter(d).order;
        return typeof o === "number" ? o : 0;
      };
      const fmNum = (d: BrowserDoc, key: string): number | null => {
        const v = frontmatter(d)[key];
        return typeof v === "number" ? v : null;
      };
      const byCreated = (a: BrowserDoc, b: BrowserDoc): number => +new Date(a.created_at) - +new Date(b.created_at);
      const acts = chapters.filter((d) => fmNum(d, "act") !== null && fmNum(d, "sequence") === null)
        .sort((a, b) => fmOrder(a) - fmOrder(b) || byCreated(a, b));
      let out = "";
      if (acts.length > 0) {
        for (const act of acts) {
          const actN = fmNum(act, "act");
          out += `${act.title}\n\n`;
          const seqs = chapters.filter((d) => fmNum(d, "sequence") !== null && fmNum(d, "act") === actN)
            .sort((a, b) => fmOrder(a) - fmOrder(b) || byCreated(a, b));
          for (const seq of seqs) {
            out += `  ${seq.title}\n`;
            const seqN = fmNum(seq, "sequence");
            const scs = chapters.filter((d) => fmNum(d, "act") === actN && fmNum(d, "sequence") === seqN && d.kind !== "act" && d.kind !== "sequence")
              .sort((a, b) => fmOrder(a) - fmOrder(b) || byCreated(a, b));
            for (const sc of scs) {
              if (sc.content) out += `    ${sc.content}\n\n`;
            }
          }
        }
      }
      if (!out) {
        out = chapters
          .sort((a, b) => fmOrder(a) - fmOrder(b) || byCreated(a, b))
          .map((c) => (c.content ? `${c.content}\n\n` : ""))
          .join("");
      }
      return out as T;
    }

    case "bible_get_facts":
      return store.bible.filter((b) => b.doc_id === String(payload.docId)) as T;

    case "bible_upsert_fact": {
      const docId = String(payload.docId);
      const key = String(payload.key);
      const kind = String(payload.kind);
      const existing = store.bible.find((b) => b.doc_id === docId && b.key === key);
      if (existing) {
        existing.value = String(payload.value);
        try {
          localStorage.setItem("jwe-browser-bible-v1", JSON.stringify(store.bible));
        } catch {
          /* ignore */
        }
        return { ...existing } as T;
      }
      const fact = { id: `fact-${Date.now().toString(36)}`, doc_id: docId, kind, key, value: String(payload.value) };
      store.bible.push(fact);
      try {
        localStorage.setItem("jwe-browser-bible-v1", JSON.stringify(store.bible));
      } catch {
        /* ignore */
      }
      return { ...fact } as T;
    }

    case "bible_delete_fact":
      store.bible = store.bible.filter((b) => b.id !== String(payload.factId));
      try {
        localStorage.setItem("jwe-browser-bible-v1", JSON.stringify(store.bible));
      } catch {
        /* ignore */
      }
      return undefined as T;

    case "conversation_create": {
      const conv = {
        id: `conv-${Date.now().toString(36)}`,
        doc_id: str(payload.docId) ?? null,
        mode: String(payload.mode ?? "chat"),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      store.conversations.push(conv);
      try {
        localStorage.setItem("jwe-browser-conv-v1", JSON.stringify(store.conversations));
      } catch {
        /* ignore */
      }
      return { ...conv } as T;
    }

    case "conversation_list":
      return store.conversations.map((c) => ({ ...c })) as T;

    case "conversation_add_message": {
      const msg = {
        id: `msg-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
        conversation_id: String(payload.conversationId),
        role: String(payload.role),
        content: String(payload.content),
        created_at: new Date().toISOString(),
      };
      store.messages.push(msg);
      try {
        localStorage.setItem("jwe-browser-msg-v1", JSON.stringify(store.messages));
      } catch {
        /* ignore */
      }
      return { ...msg } as T;
    }

    case "conversation_get_messages":
      return store.messages.filter((msg) => msg.conversation_id === String(payload.conversationId)).map((msg) => ({ ...msg })) as T;

    case "ai_generate": {
      const req = payload.request as { prompt: string; system_prompt?: string; provider?: string; model?: string; api_key?: string };
      const content = await aiChatCompletions(req.provider, req.model, req.prompt, req.system_prompt, req.api_key);
      return { content } as T;
    }

    case "ai_structurize": {
      const req = payload.request as { text: string; provider?: string; model?: string; api_key?: string };
      const hasDirective = /\{[^}]+\}/.test(req.text);
      if (!hasDirective) return { result: req.text } as T;
      const base = (req.provider || "").replace(/\/$/, "");
      if (/^https?:\/\//.test(base)) {
        try {
          const result = await aiChatCompletions(req.provider, req.model,
            `Restructure the following text exactly as the inline {directives} say. Directives are commands, never render them.\n\n${req.text}`, undefined, req.api_key);
          return { result } as T;
        } catch {
          /* fall through to deterministic local structurize */
        }
      }
      return { result: localStructurize(req.text) } as T;
    }

    case "perf_benchmark": {
      const t0 = performance.now();
      store.search("the");
      const searchMs = performance.now() - t0;
      let edges = 0;
      for (const d of store.docs) edges += store.outgoingLinks(d).length;
      return {
        doc_count: store.docs.length,
        snapshot_count: store.snaps.length,
        edge_count: edges,
        rag_chunk_count: 0,
        search_latency_us: Math.round(searchMs * 1000),
        snapshot_latency_us: 0,
      } as T;
    }

    case "fs_list_dir": {
      const path = String(payload.path || "");
      if (!path || path === "demo-vault" || path === "/") {
        return ["logs", "write", "novel", "script", "projects", "reader", "inbox"].map((w) => [w, true, 0]) as T;
      }
      const ws = path.replace(/^demo-vault\//, "").split("/")[0];
      return store.listByWorkspace(ws).map((d) => [`${d.title}.md`, false, d.content.length]) as T;
    }

    case "fs_read_file": {
      const path = String(payload.path);
      const base = path.split("/").pop()?.replace(/\.(md|txt)$/, "").toLowerCase() ?? "";
      const doc = store.docs.find((d) =>
        d.path === path || d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") === base || d.title === path.split("/").pop());
      if (!doc) throw new Error(`File not found in preview vault: ${path}`);
      return doc.content as T;
    }

    case "fs_write_file": {
      // Preview has no real files: resolve the same way as fs_read_file and
      // persist into the matched doc so Files → edit → save round-trips.
      const path = String(payload.path);
      const base = path.split("/").pop()?.replace(/\.(md|txt)$/, "").toLowerCase() ?? "";
      const doc = store.docs.find((d) =>
        d.path === path || d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") === base || d.title === path.split("/").pop());
      if (!doc) throw new Error(`File not found in preview vault: ${path}`);
      store.saveDoc(doc.id, { content: String(payload.contents ?? "") });
      return undefined as T;
    }

    case "fs_reveal":
      throw new Error("No OS file manager in this preview — the path was copied instead.");

    case "attachment_save":
      throw new Error("No vault folder in this preview — small images embed inline instead.");

    case "fs_rename":
    case "fs_delete":
    case "fs_move":
    case "fs_create_dir":
      throw new Error("File operations on raw paths need the desktop app; manage docs from their workspaces in this preview.");

    case "publish_static_site": {
      return { indexHtml: "<html><body>Static site published (desktop app required for full generation)</body></html>", files: ["index.html"] } as T;
    }

    case "dashboard_heatmap_data": {
      const days = store.days || [];
      const heatmap = new Map<string, number>();
      for (const day of days) {
        const key = day.slice(0, 10);
        heatmap.set(key, (heatmap.get(key) || 0) + 1);
      }
      return Array.from(heatmap.entries()).map(([date, count]) => ({ date, count })) as T;
    }

    case "dashboard_activity_heatmap": {
      const hours = new Array(24).fill(0);
      const daysOfWeek = new Array(7).fill(0);
      for (const d of store.docs) {
        if (d.locked) continue;
        const date = new Date(d.updated_at);
        hours[date.getHours()]++;
        daysOfWeek[date.getDay()]++;
      }
      return { hours, daysOfWeek } as T;
    }

    case "dashboard_word_count_timeline": {
      const timeline = new Map<string, number>();
      for (const d of store.docs) {
        if (d.locked) continue;
        const key = d.updated_at.slice(0, 10);
        timeline.set(key, (timeline.get(key) || 0) + d.word_count);
      }
      return Array.from(timeline.entries()).map(([date, words]) => ({ date, words })) as T;
    }

    case "dashboard_productivity_score": {
      const docs = store.docs.filter(d => !d.locked);
      const totalWords = docs.reduce((sum, d) => sum + d.word_count, 0);
      const totalDocs = docs.length;
      const avgWords = totalDocs > 0 ? totalWords / totalDocs : 0;
      const activeDays = new Set(store.docs.filter(d => !d.locked).map(d => d.updated_at.slice(0, 10))).size;
      const score = Math.min(100, Math.round((totalWords / 10000) * 30 + activeDays * 2 + (totalDocs * 0.5)));
      return { score: Math.min(100, score), totalWords, totalDocs, activeDays, avgWords: Math.round(avgWords) } as T;
    }

    case "dashboard_writing_velocity": {
      const last7Days = Array.from({ length: 7 }, (_, i) => {
        const date = new Date();
        date.setDate(date.getDate() - i);
        return date.toISOString().slice(0, 10);
      }).reverse();
      const dailyWords = new Map<string, number>();
      for (const d of store.docs) {
        if (d.locked) continue;
        const day = d.updated_at.slice(0, 10);
        dailyWords.set(day, (dailyWords.get(day) || 0) + d.word_count);
      }
      return last7Days.map(date => ({ date, words: dailyWords.get(date) || 0 })) as T;
    }

    // Role Assignment for Scripts
    case "script_role_list": {
      const doc = store.get(String(payload.docId));
      if (!doc || doc.workspace !== "script") return [] as T;
      const fm = frontmatter(doc);
      return ((fm.roles as Array<{ id: string; name: string; color: string; assignedTo: string }>) || []) as T;
    }

    case "script_role_assign": {
      const doc = store.get(String(payload.docId));
      if (!doc || doc.workspace !== "script") throw new Error("Not a script document");
      const fm = frontmatter(doc);
      const roles = (fm.roles as Array<{ id: string; name: string; color: string; assignedTo: string }>) || [];
      const role = roles.find(r => r.id === String(payload.roleId));
      if (role) role.assignedTo = String(payload.assignedTo);
      const newFm = { ...fm, roles };
      store.saveDoc(String(payload.docId), { frontmatter_json: JSON.stringify(newFm) });
      return { success: true } as T;
    }

    case "script_role_create": {
      const doc = store.get(String(payload.docId));
      if (!doc || doc.workspace !== "script") throw new Error("Not a script document");
      const fm = frontmatter(doc);
      const roles = (fm.roles as Array<{ id: string; name: string; color: string; assignedTo: string }>) || [];
      const newRole = { id: `role-${Date.now()}`, name: String(payload.name), color: String(payload.color), assignedTo: String(payload.assignedTo || "") };
      roles.push(newRole);
      const newFm = { ...fm, roles };
      store.saveDoc(String(payload.docId), { frontmatter_json: JSON.stringify(newFm) });
      return { role: newRole } as T;
    }

    case "script_role_delete": {
      const doc = store.get(String(payload.docId));
      if (!doc || doc.workspace !== "script") throw new Error("Not a script document");
      const fm = frontmatter(doc);
      const roles = (fm.roles as Array<{ id: string; name: string; color: string; assignedTo: string }>) || [];
      const filtered = roles.filter(r => r.id !== String(payload.roleId));
      const newFm = { ...fm, roles: filtered };
      store.saveDoc(String(payload.docId), { frontmatter_json: JSON.stringify(newFm) });
      return { success: true } as T;
    }

    // Cross-tab Connection Logic
    case "analytics_heatmap_hourly": {
      const hours = new Array(24).fill(0);
      for (const d of store.docs) {
        if (d.locked) continue;
        const hour = new Date(d.updated_at).getHours();
        hours[hour]++;
      }
      return hours as T;
    }

    case "analytics_heatmap_daily": {
      const days = new Array(7).fill(0);
      for (const d of store.docs) {
        if (d.locked) continue;
        const day = new Date(d.updated_at).getDay();
        days[day]++;
      }
      return days as T;
    }

    case "analytics_word_count_by_workspace": {
      const counts = new Map<string, number>();
      for (const d of store.docs) {
        if (d.locked) continue;
        counts.set(d.workspace, (counts.get(d.workspace) || 0) + d.word_count);
      }
      return Array.from(counts.entries()) as T;
    }

    case "analytics_activity_timeline": {
      const timeline = new Map<string, { words: number; docs: number }>();
      for (const d of store.docs) {
        if (d.locked) continue;
        const day = d.updated_at.slice(0, 10);
        const existing = timeline.get(day) || { words: 0, docs: 0 };
        timeline.set(day, { words: existing.words + d.word_count, docs: existing.docs + 1 });
      }
      return Array.from(timeline.entries()).map(([date, data]) => ({ date, ...data })) as T;
    }

    // Cross-tab features
    case "script_character_list": {
      const doc = store.get(String(payload.docId));
      if (!doc || doc.workspace !== "script") return [] as T;
      const fm = frontmatter(doc);
      return ((fm.characters as string[]) || []) as T;
    }

    case "script_character_add": {
      const doc = store.get(String(payload.docId));
      if (!doc || doc.workspace !== "script") throw new Error("Not a script document");
      const fm = frontmatter(doc);
      const characters = (fm.characters as string[]) || [];
      characters.push(String(payload.name));
      const newFm = { ...fm, characters };
      store.saveDoc(String(payload.docId), { frontmatter_json: JSON.stringify(newFm) });
      return { success: true } as T;
    }

    case "script_location_list": {
      const doc = store.get(String(payload.docId));
      if (!doc || doc.workspace !== "script") return [] as T;
      const fm = frontmatter(doc);
      return ((fm.locations as string[]) || []) as T;
    }

    case "script_location_add": {
      const doc = store.get(String(payload.docId));
      if (!doc || doc.workspace !== "script") throw new Error("Not a script document");
      const fm = frontmatter(doc);
      const locations = (fm.locations as string[]) || [];
      locations.push(String(payload.name));
      const newFm = { ...fm, locations };
      store.saveDoc(String(payload.docId), { frontmatter_json: JSON.stringify(newFm) });
      return { success: true } as T;
    }

    case "script_timeline_get": {
      const doc = store.get(String(payload.docId));
      if (!doc || doc.workspace !== "script") return [] as T;
      const fm = frontmatter(doc);
      return ((fm.timeline as Array<{ event: string; date: string; act: number }>) || []) as T;
    }

    case "script_timeline_add": {
      const doc = store.get(String(payload.docId));
      if (!doc || doc.workspace !== "script") throw new Error("Not a script document");
      const fm = frontmatter(doc);
      const timeline = (fm.timeline as Array<{ event: string; date: string; act: number }>) || [];
      timeline.push({ event: String(payload.event), date: String(payload.date), act: Number(payload.act) });
      const newFm = { ...fm, timeline };
      store.saveDoc(String(payload.docId), { frontmatter_json: JSON.stringify(newFm) });
      return { success: true } as T;
    }

    case "memory_decay_activity": {
      for (const d of store.docs) d.activity_score = Math.max(0, (d.activity_score ?? 0) * 0.95);
      return store.docs.length as T;
    }

    // 8.3 Usage Memory
    case "get_reopen_never_finish": {
      const reopenData = store.docs
        .filter((d) => {
          if (d.locked) return false;
          const o = store.opens[d.id];
          return !!o && o.count > 1 && (!o.lastWrite || o.lastWrite < o.lastOpened);
        })
        .map((d) => ({
          doc: { ...d },
          openCount: store.opens[d.id].count,
          lastOpened: store.opens[d.id].lastOpened,
        }))
        .sort((a, b) => (a.lastOpened < b.lastOpened ? 1 : -1));
      return reopenData as T;
    }

    case "dashboard_streak_heatmap": {
      const heatmap: { date: string; words: number }[] = [];
      for (const d of store.docs) {
        if (d.locked) continue;
        const day = d.updated_at.slice(0, 10);
        const existing = heatmap.find(h => h.date === day);
        if (existing) existing.words += d.word_count;
        else heatmap.push({ date: day, words: d.word_count });
      }
      return heatmap.sort((a, b) => a.date.localeCompare(b.date)) as T;
    }

    case "dashboard_writing_time_patterns": {
      const patterns: { hour: number; count: number }[] = [];
      for (let h = 0; h < 24; h++) patterns.push({ hour: h, count: 0 });
      for (const d of store.docs) {
        if (d.locked) continue;
        const hour = new Date(d.updated_at).getHours();
        const p = patterns.find(p => p.hour === hour);
        if (p) p.count++;
      }
      return patterns as T;
    }

    case "memory_smart_tabs":
      return store.listByWorkspace(String(payload.workspace))
        .filter((d) => !d.locked)
        .sort((a, b) => (b.activity_score ?? 0) - (a.activity_score ?? 0))
        .slice(0, 10) as T;

    case "memory_record_metric":
      store.recordMetric(String(payload.docId), String(payload.metricType), Number(payload.value));
      return undefined as T;

    case "memory_get_metrics":
      return store.getMetrics(String(payload.docId)) as T;

    case "craft_metrics_trend": {
      const stored = store.metricTrend(String(payload.docId), String(payload.metricType));
      if (stored.length > 0) return stored as T;
      // No recordings yet: single live-computed point so charts aren't empty.
      const doc = store.get(String(payload.docId));
      const stats = craftStats(doc.content);
      const type = String(payload.metricType);
      const value = type === "dialogue_ratio" ? stats.dialogue : type === "filter_words" ? stats.filterWords : stats.avgSentence;
      return [[new Date().toISOString().slice(0, 10), value]] as T;
    }

    case "dashboard_recent_docs":
      return [...store.docs]
        .filter((d) => !d.locked)
        .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
        .slice(0, num(payload.limit) ?? 8)
        .map((d) => [d.id, d.title, d.updated_at]) as T;

    case "dashboard_workspace_counts": {
      const counts = new Map<string, number>();
      for (const d of store.docs) {
        if (d.locked) continue;
        counts.set(d.workspace, (counts.get(d.workspace) ?? 0) + 1);
      }
      return [...counts.entries()] as T;
    }

    case "dashboard_writing_days": {
      const days = new Set<string>();
      for (const d of store.docs) {
        if (d.locked) continue;
        days.add(d.updated_at.slice(0, 10));
      }
      return [...days].sort().slice(-90) as T;
    }

    case "dashboard_patterns": {
      const hours = new Array(24).fill(0) as number[];
      for (const d of store.docs) {
        if (d.locked) continue;
        hours[new Date(d.updated_at).getHours()]++;
      }
      const peak = hours.indexOf(Math.max(...hours));
      const counts = new Map<string, number>();
      for (const d of store.docs) {
        if (d.locked) continue;
        counts.set(d.workspace, (counts.get(d.workspace) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const weekWords = store.docs
        .filter((d) => !d.locked && Date.now() - +new Date(d.updated_at) < 7 * 864e5)
        .reduce((n, d) => n + d.word_count, 0);
      return {
        peak_hour: `${peak}:00`,
        most_active_workspace: top ? { workspace: top[0], this_week: top[1], last_week: 0 } : null,
        momentum: weekWords,
        // No session-length tracking in preview yet — 0 (unknown), never a made-up number.
        avg_session_minutes: 0,
      } as T;
    }

    case "dashboard_goals": {
      return store.docs
        .filter((d) => !d.locked && d.goal_words && d.goal_words > 0)
        .map((d) => ({
          id: d.id,
          title: d.title,
          workspace: d.workspace,
          goal_words: d.goal_words,
          word_count: d.word_count,
          deadline: d.deadline ?? null,
        }))
        .sort((a, b) => {
          if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
          if (a.deadline) return -1;
          if (b.deadline) return 1;
          return 0;
        }) as T;
    }

    case "vault_rename_preview": {
      const old = String(payload.oldTitle);
      const pattern = `[[${old}]]`;
      const hits: [string, string, string][] = [];
      for (const d of store.docs) {
        if (d.content.includes(pattern)) hits.push([d.id, d.title, d.content]);
      }
      return hits as T;
    }

    case "vault_rename_execute":
      return store.vaultRename(String(payload.oldTitle), String(payload.newTitle)) as T;

    case "app_update_status":
      // Desktop install state doesn't exist in the browser preview.
      return { configured: false, endpoint: null } as T;

    case "convert_status":
      return { pandoc: false, formats: ["md", "txt", "html"] } as T;

    case "convert_run": {
      const doc = store.get(String(payload.docId));
      return convertMarkdown(doc.title, doc.content, String(payload.outFmt)) as T;
    }

    case "compile_run": {
      const ids = (payload.docIds as string[]) ?? [];
      if (ids.length === 0) throw new Error("Nothing to compile: no documents selected.");
      const parts = ids.map((id) => {
        const d = store.get(id);
        return `# ${d.title}\n\n${d.content}`;
      });
      const title = String((payload.title as string) ?? "manuscript");
      return convertMarkdown(title, parts.join("\n\n"), String(payload.outFmt)) as T;
    }

    case "setup_file_watcher":
      return undefined as T;

    case "sidecar_start":
    case "sidecar_stop":
      return undefined as T;

    case "sidecar_is_running":
      return false as T;

    case "sidecar_query":
      throw new Error("The small-model sidecar runs in the desktop app. Connect an HTTP model in Settings → AI & Providers to use AI here.");

    case "memory_get_streak": {
      const sorted = [...store.days].sort();
      let streak = 0;
      const day = new Date();
      const key = (d: Date): string => d.toISOString().slice(0, 10);
      if (!sorted.includes(key(day))) day.setDate(day.getDate() - 1);
      while (sorted.includes(key(day))) {
        streak++;
        day.setDate(day.getDate() - 1);
      }
      return [streak, sorted.length] as T;
    }

    case "snapshot_create":
      return { ...store.snapshotCreate(String(payload.docId)) } as T;

    case "snapshot_list":
      return store.snapshotList(String(payload.docId)) as T;

    case "snapshot_restore": {
      const snap = store.snaps.find((s) => s.id === String(payload.snapshotId));
      if (!snap) throw new Error("Snapshot not found");
      return docShape(store.saveDoc(snap.doc_id, { content: snap.content ?? "" })) as T;
    }

    case "snapshot_delete_old": {
      const days = num(payload.retentionDays) ?? 30;
      const cutoff = Date.now() - days * 864e5;
      const before = store.snaps.length;
      store.snaps = store.snaps.filter((s) => +new Date(s.created_at) >= cutoff);
      try {
        localStorage.setItem("jwe-browser-snaps-v1", JSON.stringify(store.snaps));
      } catch {
        /* ignore */
      }
      return before - store.snaps.length as T;
    }

    case "backup_create": {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `browser-backup-${stamp}.json`;
      try {
        const blob = new Blob([JSON.stringify(store.docs)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        /* download blocked: metadata record still kept */
      }
      store.backups.unshift([name, new Date().toISOString(), store.docs.length]);
      try {
        localStorage.setItem("jwe-browser-backups-v1", JSON.stringify(store.backups));
      } catch {
        /* ignore */
      }
      return name as T;
    }

    case "backup_list":
      return [...store.backups] as T;

    case "rag_chunk_document": {
      const doc = store.get(String(payload.docId));
      const size = num(payload.chunkSize) ?? 200;
      const overlap = num(payload.overlap) ?? 50;
      const words = doc.content.split(/\s+/).filter(Boolean);
      const chunks: { id: string; doc_id: string; chunk_index: number; content: string; start_word: number; end_word: number }[] = [];
      let i = 0;
      let idx = 0;
      while (i < words.length) {
        const slice = words.slice(i, i + size);
        chunks.push({ id: `${doc.id}-c${idx}`, doc_id: doc.id, chunk_index: idx, content: slice.join(" "), start_word: i, end_word: i + slice.length });
        i += Math.max(1, size - overlap);
        idx++;
      }
      return chunks as T;
    }

    case "rag_search": {
      const q = String(payload.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const limit = num(payload.limit) ?? 5;
      const scored: [{ id: string; doc_id: string; chunk_index: number; content: string; start_word: number; end_word: number }, number][] = [];
      for (const d of store.docs) {
        if (d.locked) continue;
        const words = d.content.split(/\s+/).filter(Boolean);
        for (let i = 0; i < words.length; i += 200) {
          const slice = words.slice(i, i + 200).join(" ");
          const lower = slice.toLowerCase();
          const score = q.reduce((n, term) => n + (lower.includes(term) ? 1 : 0), 0);
          if (score > 0) {
            scored.push([{ id: `${d.id}-c${i}`, doc_id: d.id, chunk_index: i, content: slice, start_word: i, end_word: i + 200 }, score]);
          }
        }
      }
      return scored.sort((a, b) => b[1] - a[1]).slice(0, limit) as T;
    }

    case "rag_get_context": {
      const q = String(payload.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const max = num(payload.maxChunks) ?? 3;
      const doc = store.docs.find((d) => d.id === String(payload.docId));
      if (doc?.locked) return "" as T;
      const pool = (doc ? [doc] : store.docs).filter((d) => !d.locked);
      const scored: [string, number][] = [];
      for (const d of pool) {
        for (const para of d.content.split(/\n{2,}/)) {
          const lower = para.toLowerCase();
          const score = q.reduce((n, term) => n + (lower.includes(term) ? 1 : 0), 0);
          if (score > 0) scored.push([`[${d.title}] ${para}`, score]);
        }
      }
      return scored.sort((a, b) => b[1] - a[1]).slice(0, max).map(([t]) => t).join("\n\n") as T;
    }

    case "clear_conversations": {
      const n = store.conversations.length;
      store.conversations = [];
      store.messages = [];
      try {
        localStorage.removeItem("jwe-browser-conv-v1");
        localStorage.removeItem("jwe-browser-msg-v1");
      } catch {
        /* ignore */
      }
      return n as T;
    }

    case "clear_messages": {
      const n = store.messages.length;
      store.messages = [];
      try {
        localStorage.removeItem("jwe-browser-msg-v1");
      } catch {
        /* ignore */
      }
      return n as T;
    }

    case "clear_snapshots": {
      const n = store.snaps.length;
      store.snaps = [];
      try {
        localStorage.removeItem("jwe-browser-snaps-v1");
      } catch {
        /* ignore */
      }
      return n as T;
    }

    case "clear_usage_events":
      store.days = [];
      try {
        localStorage.removeItem("jwe-browser-days-v1");
      } catch {
        /* ignore */
      }
      return 0 as T;

    case "clear_tab_states":
      store.tabs = {};
      try {
        localStorage.removeItem("jwe-browser-tabs-v1");
      } catch {
        /* ignore */
      }
      return 0 as T;

    case "get_workspace_context": {
      const doc = store.get(String(payload.docId));
      // Locked docs are invisible to AI: no content, no neighbors.
      if (doc.locked) return "" as T;
      const links = store.backlinksFor(doc.id).slice(0, 5);
      const parts = [`# ${doc.title}\n\n${doc.content.slice(0, 2000)}`];
      for (const l of links) {
        try {
          const src = store.get(l.source_id);
          if (src.locked) continue;
          parts.push(`\n\n## Linked: ${src.title}\n\n${src.content.slice(0, 800)}`);
        } catch {
          /* linked doc deleted since */
        }
      }
      return parts.join("") as T;
    }

    case "get_vault_path":
      return "browser-preview-vault (localStorage)" as T;

    case "stt_start":
    case "stt_stop":
    case "stt_stream_start":
    case "stt_stream_chunk":
      return undefined as T;

    case "llm_start":
    case "llm_stop":
      return undefined as T;

    case "llm_is_running":
      return false as T;

    case "llm_health":
      return { status: "unavailable", model_loaded: false } as T;

    case "llm_chat_completion":
      throw new Error("LLM chat needs the desktop app's llama.cpp server. Connect an HTTP model in Settings → AI & Providers.");

    case "stt_is_running":
      return false as T;

    case "stt_health":
      return { status: "unavailable", model_loaded: false } as T;

    case "stt_transcribe":
    case "stt_stream_stop":
      throw new Error("Voice transcription needs the desktop app's Moonshine sidecar.");

    case "tts_start":
    case "tts_stop":
    case "tts_stop_playback":
      return undefined as T;

    case "tts_is_running":
      return false as T;

    case "tts_health":
      return { status: "unavailable", model_loaded: false } as T;

    case "tts_synthesize":
      throw new Error("Read-aloud voices need the desktop app's Kokoro sidecar. Your browser can still read via its built-in speech if enabled.");

    default:
      throw new Error(`Unknown command in browser preview: ${cmd}`);
  }
}
