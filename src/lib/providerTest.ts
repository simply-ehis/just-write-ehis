/**
 * providerTest — Amendment 6 `settings.provider.test`: ping an
 * OpenAI-compatible endpoint and report latency + model presence,
 * so a dead endpoint surfaces here instead of mid-sentence.
 */
export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
  modelFound: boolean;
  error: string;
}

export async function testProvider(endpoint: string, model: string): Promise<ProviderTestResult> {
  const base = (endpoint || "").replace(/\/$/, "");
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/models`);
    const latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      return { ok: false, latencyMs, models: [], modelFound: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    return {
      ok: true,
      latencyMs,
      models: models.slice(0, 20),
      modelFound: models.some((id) => id === model || id.endsWith(`/${model}`)),
      error: "",
    };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - t0),
      models: [],
      modelFound: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
