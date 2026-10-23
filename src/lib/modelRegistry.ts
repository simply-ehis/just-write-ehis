/**
 * modelRegistry — model identity, tags, and validation.
 *
 * Prevents:
 * - Using a TTS/STT model for LLM inference (wrong outputs)
 * - Feeding LLM output back as input without detection (looping)
 * - Quantization mismatches between what's fetched and what's expected
 *
 * Every model in the bundle carries a metadata file (model.json) with:
 *   type: "llm" | "tts" | "stt"
 *   quantization: "q4_k_m" | "q5_k_m" | "q8_0" | ...
 *   architecture: "lfm2" | "moonshine" | "phonon" | ...
 *   tags: string[] — e.g. ["chat", "completion"], ["synthesis"], ["transcription"]
 *   context_limit: number — max tokens the model was trained for
 *   recommended_threads: number
 *   recommended_gpu_layers: number
 */

export type ModelType = "llm" | "tts" | "stt";

export interface ModelMetadata {
  name: string;
  type: ModelType;
  quantization: string;
  architecture: string;
  tags: string[];
  context_limit: number;
  recommended_threads: number;
  recommended_gpu_layers: number;
  description: string;
  filename: string;
  size_bytes: number;
  sha256?: string;
}

/** Known model registry — updated when fetch_sidecars.py adds new models. */
export const MODEL_REGISTRY: Record<string, ModelMetadata> = {
  "lfm2.5-350m-q4_k_m.gguf": {
    name: "LFM 2.5-350M Q4_K_M",
    type: "llm",
    quantization: "q4_k_m",
    architecture: "lfm2",
    tags: ["chat", "completion", "writing"],
    context_limit: 8192,
    recommended_threads: 4,
    recommended_gpu_layers: 0,
    description: "Balanced quality/speed, 350M params, Q4_K_M quantization",
    filename: "lfm2.5-350m-q4_k_m.gguf",
    size_bytes: 229_312_224,
  },
  "lfm2.5-350m-q5_k_m.gguf": {
    name: "LFM 2.5-350M Q5_K_M",
    type: "llm",
    quantization: "q5_k_m",
    architecture: "lfm2",
    tags: ["chat", "completion", "writing", "higher-quality"],
    context_limit: 8192,
    recommended_threads: 4,
    recommended_gpu_layers: 0,
    description: "Higher quality than Q4, slightly slower, 350M params",
    filename: "lfm2.5-350m-q5_k_m.gguf",
    size_bytes: 280_000_000,
  },
  "lfm2.5-350m-q8_0.gguf": {
    name: "LFM 2.5-350M Q8_0",
    type: "llm",
    quantization: "q8_0",
    architecture: "lfm2",
    tags: ["chat", "completion", "writing", "highest-quality"],
    context_limit: 8192,
    recommended_threads: 4,
    recommended_gpu_layers: 0,
    description: "Near-fp16 quality, slowest, 350M params",
    filename: "lfm2.5-350m-q8_0.gguf",
    size_bytes: 420_000_000,
  },
  "moonshine-base-Q8_0.gguf": {
    name: "Moonshine Base Q8_0",
    type: "stt",
    quantization: "q8_0",
    architecture: "moonshine",
    tags: ["transcription", "voice-to-text"],
    context_limit: 0,
    recommended_threads: 4,
    recommended_gpu_layers: 0,
    description: "Fast, accurate speech-to-text, Q8_0 quantization",
    filename: "moonshine-base-Q8_0.gguf",
    size_bytes: 77_476_480,
  },
  "phonon-31m-en": {
    name: "Phonon 31M English",
    type: "tts",
    quantization: "q8_0",
    architecture: "phonon",
    tags: ["synthesis", "text-to-speech", "english"],
    context_limit: 0,
    recommended_threads: 4,
    recommended_gpu_layers: 0,
    description: "Gradium Phonon 31M English TTS, q8 GGUF + Rust runtime (Apache-2.0)",
    filename: "phonon-31m-en",
    size_bytes: 61_000_000,
  },
};

/** All known LLM quantization options for the bundled model. */
export const LLM_QUANTIZATIONS = [
  { id: "q4_k_m", label: "Q4_K_M — balanced (default)", filename: "lfm2.5-350m-q4_k_m.gguf" },
  { id: "q5_k_m", label: "Q5_K_M — higher quality", filename: "lfm2.5-350m-q5_k_m.gguf" },
  { id: "q8_0", label: "Q8_0 — near-fp16 quality", filename: "lfm2.5-350m-q8_0.gguf" },
] as const;

export type LlmQuantization = (typeof LLM_QUANTIZATIONS)[number]["id"];

/** Get metadata for a model by filename or directory name. */
export function getModelMetadata(key: string): ModelMetadata | undefined {
  return MODEL_REGISTRY[key];
}

/** Get metadata for the currently configured LLM quantization. */
export function getLlmMetadata(quant: LlmQuantization): ModelMetadata | undefined {
  const entry = LLM_QUANTIZATIONS.find((q) => q.id === quant);
  if (!entry) return undefined;
  return MODEL_REGISTRY[entry.filename];
}

/** Validate that a model is appropriate for a given task. */
export function validateModelForTask(
  modelKey: string,
  task: "llm" | "tts" | "stt"
): { ok: boolean; error?: string } {
  const meta = MODEL_REGISTRY[modelKey];
  if (!meta) return { ok: false, error: `Unknown model: ${modelKey}` };
  if (meta.type !== task) {
    return {
      ok: false,
      error: `Model "${meta.name}" is a ${meta.type.toUpperCase()} model, not a ${task.toUpperCase()} model. Using it for ${task} will produce wrong outputs.`,
    };
  }
  return { ok: true };
}

/** Check if a model's tags include a specific capability. */
export function modelHasTag(modelKey: string, tag: string): boolean {
  const meta = MODEL_REGISTRY[modelKey];
  return meta?.tags.includes(tag) ?? false;
}

/** Detect potential output-to-input loops in conversation history. */
export interface LoopDetectionResult {
  hasLoop: boolean;
  reason?: string;
  confidence: number;
}

/** Simple heuristic: if the last N assistant messages are nearly identical,
 * the model may be stuck in a repetition loop. */
export function detectRepetitionLoop(
  messages: Array<{ role: string; content: string }>,
  window = 3,
  similarityThreshold = 0.9
): LoopDetectionResult {
  const assistantMsgs = messages
    .filter((m) => m.role === "assistant")
    .slice(-window)
    .map((m) => m.content.trim());

  if (assistantMsgs.length < window) return { hasLoop: false, confidence: 0 };

  // Check pairwise similarity
  for (let i = 0; i < assistantMsgs.length - 1; i++) {
    for (let j = i + 1; j < assistantMsgs.length; j++) {
      const sim = similarity(assistantMsgs[i], assistantMsgs[j]);
      if (sim >= similarityThreshold) {
        return {
          hasLoop: true,
          reason: `Assistant messages ${i} and ${j} are ${Math.round(sim * 100)}% similar`,
          confidence: sim,
        };
      }
    }
  }
  return { hasLoop: false, confidence: 0 };
}

/** Jaccard similarity on word shingles. */
function similarity(a: string, b: string): number {
  const shinglesA = new Set(shingleWords(a));
  const shinglesB = new Set(shingleWords(b));
  if (shinglesA.size === 0 && shinglesB.size === 0) return 1;
  if (shinglesA.size === 0 || shinglesB.size === 0) return 0;
  const intersection = [...shinglesA].filter((x) => shinglesB.has(x)).length;
  const union = shinglesA.size + shinglesB.size - intersection;
  return intersection / union;
}

function shingleWords(text: string, k = 3): string[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < k) return [text];
  const out: string[] = [];
  for (let i = 0; i <= words.length - k; i++) {
    out.push(words.slice(i, i + k).join(" "));
  }
  return out;
}

/** Get recommended llama-server args for a quantization. */
export function getLlamaServerArgs(quant: LlmQuantization, cpuCores: number): string[] {
  const meta = getLlmMetadata(quant);
  const threads = meta?.recommended_threads ?? Math.max(1, Math.floor(cpuCores * 0.75));
  const gpuLayers = meta?.recommended_gpu_layers ?? 0;

  return [
    "--threads",
    threads.toString(),
    "--n-gpu-layers",
    gpuLayers.toString(),
    "--parallel",
    "2",
    "--batch-size",
    "512",
    "--ubatch-size",
    "512",
    "--flash-attn",
    "1",
  ];
}