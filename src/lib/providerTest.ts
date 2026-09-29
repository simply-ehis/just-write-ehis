/**
 * providerTest — Amendment 6 `settings.provider.test`: ping an
 * OpenAI-compatible endpoint and report latency + model presence,
 * so a dead endpoint surfaces here instead of mid-sentence.
 *
 * Browser/preview path only: the desktop shell routes through the
 * `provider_probe` Rust command instead (api.providerProbe), so the
 * stored key is attached and the webview CSP can't block the host.
 */
export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
  modelFound: boolean;
  error: string;
}

/** Cap model lists (both backends truncate at 20). */
export function capModels(models: string[]): string[] {
  return models.slice(0, 20);
}

/** Exact or `org/model`-suffix match; empty model never matches. */
export function matchModel(models: string[], model: string): boolean {
  if (!model) return false;
  return models.some((id) => id === model || id.endsWith(`/${model}`));
}

export async function testProvider(endpoint: string, model?: string, apiKey?: string): Promise<ProviderTestResult> {
  const base = (endpoint || "").replace(/\/$/, "");
  const t0 = performance.now();
  const fail = (error: string): ProviderTestResult => ({
    ok: false,
    latencyMs: Math.round(performance.now() - t0),
    models: [],
    modelFound: false,
    error,
  });
  // Reject non-URLs fast: without this an empty endpoint becomes a relative
  // `/models` fetch and a hung host hangs forever (Rust caps at 15s).
  if (!/^https?:\/\//i.test(base)) {
    return fail("endpoint must be an http(s) URL");
  }
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15000) });
    const latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      return { ok: false, latencyMs, models: [], modelFound: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { data?: { id?: string }[] };
    const models = capModels((data.data ?? []).map((m) => m.id ?? "").filter(Boolean));
    return {
      ok: true,
      latencyMs,
      models,
      modelFound: matchModel(models, model ?? ""),
      error: "",
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
