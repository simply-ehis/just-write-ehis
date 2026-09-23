/**
 * import — batch export helper (live: command palette "Export Open Tabs").
 *
 * The old Obsidian/Notion/markdown/JSON import stubs were deleted
 * 2026-09-23: they fabricated document ids without creating docs, so
 * keeping them was worse than having no importer. Book/prose import now
 * lives in importFile.ts (one shared entry point for Novel/Reader/Script).
 */

export async function batchExport(docIds: string[], format: 'md' | 'txt' | 'html' | 'docx' | 'epub' | 'pdf' | 'zip', _options: { includeAttachments?: boolean; zipPassword?: string } = {}): Promise<{ filename: string; base64: string }> {
  if (docIds.length === 0) throw new Error("No documents to export.");
  if (_options.zipPassword) {
    throw new Error("Password-protected zips aren't supported — export unencrypted.");
  }
  const { api } = await import("$lib/api");

  // Convert every doc through the real backend (pandoc sidecar where needed).
  const converted: { filename: string; base64: string }[] = [];
  for (const id of docIds) {
    const out = await api.convertRun(id, format === 'zip' ? 'md' : format);
    converted.push({ filename: out.filename, base64: out.base64 });
  }

  // Single doc, single format: hand the backend output straight through.
  if (converted.length === 1 && format !== 'zip') {
    return converted[0];
  }

  // Otherwise bundle into a zip (unique-ified filenames, no silent overwrites).
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const used = new Set<string>();
  const stamp = new Date().toISOString().slice(0, 10);
  for (const { filename, base64 } of converted) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let name = filename;
    for (let n = 2; used.has(name); n++) {
      const dot = filename.lastIndexOf(".");
      name = dot === -1 ? `${filename} (${n})` : `${filename.slice(0, dot)} (${n})${filename.slice(dot)}`;
    }
    used.add(name);
    zip.file(name, bytes);
  }
  const blob: Blob = await zip.generateAsync({ type: "blob" });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return { filename: `just-write-export-${stamp}.zip`, base64: btoa(bin) };
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