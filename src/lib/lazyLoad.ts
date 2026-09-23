/**
 * lazyLoad — shared failure-safe loader for code-split views.
 *
 * A dynamic import can REJECT (chunk 404, CSP block, stale reference
 * after an update) or NEVER SETTLE (a stylesheet <link> injected by
 * Vite's preload helper whose load/error events never fire). Both must
 * land in a diagnosable failed state — never "Loading…" forever in
 * silence. LazyWorkspace.svelte renders this contract; the logic lives
 * here so it is unit-testable without mounting components.
 */
export const LAZY_LOAD_TIMEOUT_MS = 9000;

export type LazyLoadResult =
  | { ok: true; module: unknown }
  | { ok: false; message: string };

export async function loadWithTimeout(
  loader: () => Promise<unknown>,
  label: string,
  timeoutMs: number = LAZY_LOAD_TIMEOUT_MS
): Promise<LazyLoadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out after ${timeoutMs / 1000}s waiting for the ${label} code chunk.`
          )
        ),
      timeoutMs
    );
  });
  try {
    const m = await Promise.race([loader(), timeout]);
    return { ok: true, module: (m as { default?: unknown }).default ?? m };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
