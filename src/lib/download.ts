/**
 * download — save a base64 backend payload as a file.
 * Works identically in the browser preview and the Tauri webview.
 */
import type { ConvertOutput } from "$lib/api";

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function downloadConvertOutput(out: ConvertOutput): void {
  const blob = new Blob([base64ToBytes(out.base64)], { type: out.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = out.filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Raw Fountain source download (no backend: fountain IS the source). */
export function downloadFountain(title: string, content: string): void {
  const safe = (title || "untitled").trim() || "untitled";
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}.fountain`;
  a.click();
  URL.revokeObjectURL(url);
}
