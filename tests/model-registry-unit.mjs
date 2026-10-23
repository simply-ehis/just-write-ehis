/**
 * model-registry-unit — unit checks for the model registry
 * (src/lib/modelRegistry.ts): metadata lookup, validation, loop detection.
 *
 * Run: node tests/model-registry-unit.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const {
  MODEL_REGISTRY,
  LLM_QUANTIZATIONS,
  getModelMetadata,
  getLlmMetadata,
  validateModelForTask,
  modelHasTag,
  detectRepetitionLoop,
  getLlamaServerArgs,
} = await import(pathToFileURL(join(root, "src/lib/modelRegistry.ts")).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Registry completeness
check("registry has LFM Q4", !!MODEL_REGISTRY["lfm2.5-350m-q4_k_m.gguf"]);
check("registry has LFM Q5", !!MODEL_REGISTRY["lfm2.5-350m-q5_k_m.gguf"]);
check("registry has LFM Q8", !!MODEL_REGISTRY["lfm2.5-350m-q8_0.gguf"]);
check("registry has Moonshine", !!MODEL_REGISTRY["moonshine-base-Q8_0.gguf"]);
check("registry has Phonon 31M", !!MODEL_REGISTRY["phonon-31m-en"]);
check("LLM_QUANTIZATIONS has q4_k_m", LLM_QUANTIZATIONS.some((q) => q.id === "q4_k_m"));
check("LLM_QUANTIZATIONS has q5_k_m", LLM_QUANTIZATIONS.some((q) => q.id === "q5_k_m"));
check("LLM_QUANTIZATIONS has q8_0", LLM_QUANTIZATIONS.some((q) => q.id === "q8_0"));

// Metadata lookup
const q4 = getModelMetadata("lfm2.5-350m-q4_k_m.gguf");
check("Q4 metadata type=llm", q4?.type === "llm");
check("Q4 metadata arch=lfm2", q4?.architecture === "lfm2");
check("Q4 metadata quant=q4_k_m", q4?.quantization === "q4_k_m");
check("Q4 metadata tags include chat", q4?.tags.includes("chat"));
check("Q4 context_limit=8192", q4?.context_limit === 8192);

const stt = getModelMetadata("moonshine-base-Q8_0.gguf");
check("STT metadata type=stt", stt?.type === "stt");
check("STT metadata arch=moonshine", stt?.architecture === "moonshine");

const tts = getModelMetadata("phonon-31m-en");
check("TTS metadata type=tts", tts?.type === "tts");
check("TTS metadata arch=phonon", tts?.architecture === "phonon");

// getLlmMetadata
check("getLlmMetadata q4_k_m", getLlmMetadata("q4_k_m")?.quantization === "q4_k_m");
check("getLlmMetadata q5_k_m", getLlmMetadata("q5_k_m")?.quantization === "q5_k_m");
check("getLlmMetadata q8_0", getLlmMetadata("q8_0")?.quantization === "q8_0");
check("getLlmMetadata unknown returns undefined", getLlmMetadata("nonexistent") === undefined);

// Task validation
check("validate LFM for llm: ok", validateModelForTask("lfm2.5-350m-q4_k_m.gguf", "llm").ok);
check("validate Moonshine for llm: fail", !validateModelForTask("moonshine-base-Q8_0.gguf", "llm").ok);
check("validate Phonon for tts: ok", validateModelForTask("phonon-40m-multilingual", "tts").ok);
check("validate LFM for tts: fail", !validateModelForTask("lfm2.5-350m-q4_k_m.gguf", "tts").ok);
check("validate unknown model: fail", !validateModelForTask("unknown.gguf", "llm").ok);

// Tag checking
check("modelHasTag LFM chat", modelHasTag("lfm2.5-350m-q4_k_m.gguf", "chat"));
check("modelHasTag Moonshine transcription", modelHasTag("moonshine-base-Q8_0.gguf", "transcription"));
check("modelHasTag Phonon synthesis", modelHasTag("phonon-40m-multilingual", "synthesis"));
check("modelHasTag unknown tag: false", !modelHasTag("lfm2.5-350m-q4_k_m.gguf", "nonexistent"));

// Loop detection
const identicalMsgs = [
  { role: "assistant", content: "Hello world, this is a test message." },
  { role: "assistant", content: "Hello world, this is a test message." },
  { role: "assistant", content: "Hello world, this is a test message." },
];
check("detectRepetitionLoop: identical messages", detectRepetitionLoop(identicalMsgs).hasLoop);

const differentMsgs = [
  { role: "assistant", content: "First message here." },
  { role: "assistant", content: "Second message is different." },
  { role: "assistant", content: "Third one is also different." },
];
check("detectRepetitionLoop: different messages", !detectRepetitionLoop(differentMsgs).hasLoop);

const shortHistory = [
  { role: "assistant", content: "Only one message." },
];
check("detectRepetitionLoop: short history", !detectRepetitionLoop(shortHistory).hasLoop);

// Similar messages (high similarity - uses 3-word shingles, Jaccard)
const similarMsgs = [
  { role: "assistant", content: "The quick brown fox jumps over the lazy dog." },
  { role: "assistant", content: "The quick brown fox jumps over the lazy dog." },
  { role: "assistant", content: "The quick brown fox jumps over the lazy dog." },
];
const similarResult = detectRepetitionLoop(similarMsgs);
check("detectRepetitionLoop: similar messages", similarResult.hasLoop);

// getLlamaServerArgs
const argsQ4 = getLlamaServerArgs("q4_k_m", 8);
check("getLlamaServerArgs has threads", argsQ4.some((a) => a === "--threads"));
check("getLlamaServerArgs has gpu_layers", argsQ4.some((a) => a === "--n-gpu-layers"));
check("getLlamaServerArgs has parallel", argsQ4.some((a) => a === "--parallel"));
check("getLlamaServerArgs has flash_attn", argsQ4.some((a) => a === "--flash-attn"));

console.log(failures === 0 ? "\nMODEL-REGISTRY-UNIT ALL PASS" : `\n${failures} FAILURES`);
if (failures) process.exit(1);