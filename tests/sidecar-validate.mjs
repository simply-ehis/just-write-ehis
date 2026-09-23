/**
 * sidecar-validate — unit checks for sidecar settings validation
 * (src/lib/sidecarValidate.ts), the UI half of fail-closed model paths
 * (the python servers enforce the same rules at startup).
 *
 * Run: node tests/sidecar-validate.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = await import(pathToFileURL(join(root, "src/lib/sidecarValidate.ts")).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Traversal: .. escapes rejected...
check("dotdot rejected", v.hasTraversal("../vault/secret") === true);
check("nested dotdot rejected", v.hasTraversal("models/../../etc/passwd") === true);
check("backslash dotdot rejected", v.hasTraversal("..\\secret") === true);
// ...but plain and absolute picks are a server-side existence question.
check("bare name ok", v.hasTraversal("moonshine-base-Q8_0.gguf") === false);
check("absolute ok at this layer", v.hasTraversal("C:/models/custom.gguf") === false);

check("empty stt ok (bundled)", v.validateSttModel("") === null);
check("legacy stt ok", v.validateSttModel("moonshine-v2-q6") === null);
check("gguf name ok", v.validateSttModel("custom.gguf") === null);
check("traversal stt rejected", v.validateSttModel("../x.gguf") !== null);
check("non-gguf stt rejected", v.validateSttModel("model.onnx") !== null);

check("empty tts ok (vendored)", v.validateTtsModel("") === null);
check("legacy tts ok", v.validateTtsModel("hexgrad/Kokoro-82M") === null);
check("bundle dir ok", v.validateTtsModel("my-voices") === null);
check("file-as-tts rejected", v.validateTtsModel("model.onnx") !== null);
check("traversal tts rejected", v.validateTtsModel("../../etc") !== null);

check("empty llm ok (bundled)", v.validateLlmModel("") === null);
check("llm gguf ok", v.validateLlmModel("lfm2.5-350m-q4_k_m.gguf") === null);
check("llm traversal rejected", v.validateLlmModel("../evil.gguf") !== null);

check("empty python rejected", v.validatePythonPath("") !== null);
check("python path ok", v.validatePythonPath("python") === null);

console.log(failures === 0 ? "SIDECAR-VALIDATE ALL PASS" : `SIDECAR-VALIDATE ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
