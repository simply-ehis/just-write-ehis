/**
 * attachments — dropped/pasted files land in `<vault>/.attachments/` (A8.9).
 *
 * Desktop: bytes go through `attachment_save` (backend resolves the real
 * vault dir, sanitizes the name, writes atomically) and the doc gets a
 * relative `.attachments/<name>` ref. Browser preview has no vault files,
 * so small images fall back to data URLs (viewable, portable); anything
 * bigger is refused with a clear message instead of a broken link.
 */
import { api } from "$lib/api";
import { showToast } from "$lib/stores/notifications";
import type { EditorView } from "@codemirror/view";

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp"];
const PREVIEW_DATA_URL_LIMIT = 2_000_000; // bytes

/** Chunked base64 (btoa over a spread args array blows the stack on big files). */
export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function isImageName(name: string): boolean {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

/**
 * Save `file` and insert the markdown ref at the cursor.
 * Returns true when a ref was inserted.
 */
export async function attachFile(view: EditorView, file: File): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    showToast(`Couldn't read ${file.name}`, "error");
    return false;
  }
  if (bytes.length === 0) {
    showToast(`${file.name} is empty`, "warning");
    return false;
  }

  let ref: string;
  try {
    ref = await api.attachmentSave(file.name, bytesToB64(bytes));
  } catch (e) {
    // Preview (or a backend hiccup): embed small images inline so paste
    // still works; refuse anything bigger instead of writing a dead link.
    if (isImageName(file.name) && bytes.length <= PREVIEW_DATA_URL_LIMIT) {
      const mime = file.type || "image/png";
      ref = `data:${mime};base64,${bytesToB64(bytes)}`;
      showToast("Preview: image embedded inline (desktop saves to vault)", "info");
    } else {
      showToast(`Couldn't save ${file.name}: ${e instanceof Error ? e.message : e}`, "error");
      return false;
    }
  }

  const { from } = view.state.selection.main;
  const insert = isImageName(file.name) || ref.startsWith("data:")
    ? `![${file.name}](${ref})`
    : `[${file.name}](${ref})`;
  view.dispatch({ changes: { from, insert } });
  view.focus();
  return true;
}

/** Attach every file in a drop/paste list, in order. */
export async function attachFiles(view: EditorView, files: File[] | FileList): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;
  let done = 0;
  for (const file of list) {
    if (await attachFile(view, file)) done++;
  }
  if (done > 0) showToast(`Attached ${done} file${done === 1 ? "" : "s"}`, "success");
}
