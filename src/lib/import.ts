/**
 * import — batch export helper (live: command palette "Export Open Tabs").
 *
 * The old Obsidian/Notion/markdown/JSON import stubs were deleted
 * 2026-09-23: they fabricated document ids without creating docs, so
 * keeping them was worse than having no importer. Book/prose import now
 * lives in importFile.ts (one shared entry point for Novel/Reader/Script).
 */

export interface BatchProgress {
  done: number;
  total: number;
}

export interface BatchOptions {
  includeAttachments?: boolean;
  zipPassword?: string;
  onProgress?: (p: BatchProgress) => void;
  /** Polled between docs — return true to abort the batch. */
  shouldCancel?: () => boolean;
  /** Convert worker count (default 4). */
  concurrency?: number;
}

export interface BatchResult {
  filename: string;
  base64: string;
  attachmentsBundled: number;
  attachmentsSkipped: number;
}

/**
 * N-way bounded worker pool. Same shape as Novel's chapter import loop
 * (Area 9) — sequential batches over async per-item work — generalized
 * to N lanes so batch export converts with concurrency.
 */
export interface BatchItemError {
  index: number;
  message: string;
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onDone?: (done: number, total: number) => void,
  shouldCancel?: () => boolean,
): Promise<{ results: (R | undefined)[]; errors: BatchItemError[]; cancelled: boolean }> {
  const results: (R | undefined)[] = new Array(items.length);
  const errors: BatchItemError[] = [];
  let next = 0;
  let done = 0;
  let cancelled = false;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < items.length) {
        if (cancelled || shouldCancel?.()) {
          cancelled = true;
          return;
        }
        const i = next++;
        try {
          results[i] = await fn(items[i], i);
        } catch (e) {
          // Per-doc failure recorded, never aborts siblings.
          errors.push({ index: i, message: e instanceof Error ? e.message : String(e) });
        }
        done++;
        onDone?.(done, items.length);
      }
    }),
  );
  return { results, errors, cancelled };
}

/** Unique-ify a filename against already-used names (no silent overwrites). */
export function dedupeFilename(used: Set<string>, filename: string): string {
  let name = filename;
  for (let n = 2; used.has(name); n++) {
    const dot = filename.lastIndexOf(".");
    name = dot === -1 ? `${filename} (${n})` : `${filename.slice(0, dot)} (${n})${filename.slice(dot)}`;
  }
  used.add(name);
  return name;
}

function b64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(buf: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function batchExport(
  docIds: string[],
  format: 'md' | 'txt' | 'html' | 'docx' | 'epub' | 'pdf' | 'zip',
  options: BatchOptions = {},
): Promise<BatchResult> {
  if (docIds.length === 0) throw new Error("No documents to export.");
  if (options.zipPassword) {
    throw new Error("Password-protected zips aren't supported — export unencrypted.");
  }
  const { api } = await import("$lib/api");
  const target = format === 'zip' ? 'md' : format;

  // Convert with 4-way concurrency through the real backend (pandoc
  // sidecar where needed). Failures are per-doc, never batch-aborting
  // (except explicit cancel).
  const { results, errors, cancelled } = await mapLimit(
    docIds,
    options.concurrency ?? 4,
    async (id) => {
      const out = await api.convertRun(id, target);
      return { id, filename: out.filename, base64: out.base64 };
    },
    (done, total) => options.onProgress?.({ done, total }),
    options.shouldCancel,
  );
  if (cancelled) throw new Error("Export cancelled.");
  const converted = results.filter(
    (r): r is { id: string; filename: string; base64: string } => !!r,
  );
  if (converted.length === 0) {
    throw new Error(`Export failed: ${errors[0]?.message ?? "no documents converted"}`);
  }

  // Single doc, single format: hand the backend output straight through.
  if (converted.length === 1 && format !== 'zip') {
    return { ...converted[0], attachmentsBundled: 0, attachmentsSkipped: 0 };
  }

  // Otherwise bundle into a zip (streamed files, DEFLATE; attachments
  // bundled under their vault-relative refs so links keep working —
  // this replaces the old "copy .attachments/ alongside" warning).
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const used = new Set<string>();
  const stamp = new Date().toISOString().slice(0, 10);
  let attachmentsBundled = 0;
  let attachmentsSkipped = 0;
  const attachSeen = new Set<string>();
  let zipped = 0;
  for (const { id, filename, base64 } of converted) {
    if (options.shouldCancel?.()) throw new Error("Export cancelled.");
    zip.file(dedupeFilename(used, filename), b64ToBytes(base64));
    zipped++;
    if (options.includeAttachments !== false) {
      try {
        const doc = await api.docGet(id);
        const refs = [...(doc.content || "").matchAll(/\.attachments\/[^\s)"']+/g)].map((m) => m[0]);
        for (const ref of new Set(refs)) {
          if (attachSeen.has(ref)) continue;
          attachSeen.add(ref);
          try {
            const b64 = await api.attachmentRead(ref);
            zip.file(ref, b64ToBytes(b64));
            attachmentsBundled++;
          } catch {
            attachmentsSkipped++;
          }
        }
      } catch {
        /* unreadable doc body: converted output already saved above */
      }
    }
    options.onProgress?.({ done: zipped, total: converted.length });
  }
  const blob: Blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", streamFiles: true });
  const buf = new Uint8Array(await blob.arrayBuffer());
  return {
    filename: `just-write-export-${stamp}.zip`,
    base64: bytesToB64(buf),
    attachmentsBundled,
    attachmentsSkipped,
  };
}

export function generateSyncManifest(documents: any[]): string {
  return JSON.stringify({
    version: 1,
    exported: new Date().toISOString(),
    app: 'Just Write ehis',
    documents: documents.map(d => ({
      id: d.id,
      title: d.title,
      workspace: d.workspace,
      kind: d.kind,
      content: d.content,
      frontmatter: d.frontmatter_json,
      created_at: d.created_at,
      updated_at: d.updated_at,
      word_count: d.word_count,
      status: d.status,
      parent_id: d.parent_id,
    })),
  }, null, 2);
}

export async function parseSyncManifest(manifest: string): Promise<any[]> {
  const data = JSON.parse(manifest);
  return data.documents || [];
}