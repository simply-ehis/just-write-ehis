/**
 * Attachments — dropped/pasted files land in `<vault>/.attachments/`.
 *
 * Static images are resized and compressed to WebP before saving. Desktop:
 * bytes go through `attachment_save` (backend resolves the real
 * vault dir, sanitizes the name, writes atomically) and the doc gets a
 * relative `.attachments/<name>` ref. Browser preview has no vault files,
 * so small images fall back to data URLs (viewable, portable); anything
 * bigger is refused with a clear message instead of a broken link.
 */
import { api } from "$lib/api";
import { showToast } from "$lib/stores/notifications";
import type { EditorView } from "@codemirror/view";

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];
const COMPRESSIBLE_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "bmp"]);
const PREVIEW_DATA_URL_LIMIT = 2_000_000; // bytes
const IMAGE_MAX_EDGE = 2048;
const IMAGE_COMPRESS_THRESHOLD = 300_000;

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

async function compressImage(file: File, original: Uint8Array): Promise<{ name: string; bytes: Uint8Array }> {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  // Canvas conversion drops GIF animation; keep GIFs intact.
  if (!COMPRESSIBLE_IMAGE_EXTS.has(ext)) {
    return { name: file.name, bytes: original };
  }
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && original.byteLength < IMAGE_COMPRESS_THRESHOLD) {
      return { name: file.name, bytes: original };
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return { name: file.name, bytes: original };
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
    if (!blob || blob.type !== "image/webp") return { name: file.name, bytes: original };
    const compressed = new Uint8Array(await blob.arrayBuffer());
    if (compressed.length >= original.length) return { name: file.name, bytes: original };
    return {
      name: `${file.name.replace(/\.[^.]+$/, "") || "image"}.webp`,
      bytes: compressed,
    };
  } catch {
    // Unsupported/invalid images remain attachable in their original form.
    return { name: file.name, bytes: original };
  } finally {
    bitmap?.close();
  }
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

  const prepared = isImageName(file.name) ? await compressImage(file, bytes) : { name: file.name, bytes };
  bytes = prepared.bytes;

  let ref: string;
  try {
    ref = await api.attachmentSave(prepared.name, bytesToB64(bytes));
  } catch (e) {
    // Preview (or a backend hiccup): embed small images inline so paste
    // still works; refuse anything bigger instead of writing a dead link.
    if (isImageName(file.name) && bytes.length <= PREVIEW_DATA_URL_LIMIT) {
      const ext = prepared.name.split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "webp"
        ? "image/webp"
        : file.type || ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", bmp: "image/bmp" }[ext] ?? "image/png");
      ref = `data:${mime};base64,${bytesToB64(bytes)}`;
      showToast("Preview: image embedded inline (desktop saves to vault)", "info");
    } else {
      showToast(`Couldn't save ${file.name}: ${e instanceof Error ? e.message : e}`, "error");
      return false;
    }
  }

  const { from } = view.state.selection.main;
  const insert = isImageName(file.name) || ref.startsWith("data:")
    ? `![${file.name.replace(/\.[^.]+$/, "")}](${ref})`
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
