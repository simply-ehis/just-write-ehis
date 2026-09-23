/**
 * ai-request-unit — unit checks for the shared AI request plumbing
 * (src/lib/aiRequest.ts): friendly-error mapping, 429/503-only retry
 * gating, and the rate-limit cooldown check. The same strings are
 * mirrored in Rust (friendly_http_status, cargo-tested) and consumed
 * by AiPanel + browserBackend.
 *
 * Run: node tests/ai-request-unit.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { friendlyEndpointError, shouldRetryStatus, rateLimited } = await import(
  pathToFileURL(join(root, "src/lib/aiRequest.ts")).href
);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

check("401 maps to key rejection", friendlyEndpointError(new Error("HTTP 401")).includes("API key"));
check("403 maps to key rejection", friendlyEndpointError("403 forbidden").includes("API key"));
check("429 maps to rate limit", friendlyEndpointError("HTTP 429").includes("Rate limited"));
check("408 maps to timeout", friendlyEndpointError("408").includes("timed out"));
check("timeout text maps", friendlyEndpointError("request timed out after 90s").includes("timed out"));
check("503 maps to overloaded", friendlyEndpointError("503").includes("overloaded"));
check("ECONNREFUSED maps to unreachable", friendlyEndpointError("ECONNREFUSED boom").includes("Can't reach"));
check("network maps to unreachable", friendlyEndpointError("network error").includes("Can't reach"));
check("Failed to fetch maps to unreachable", friendlyEndpointError("Failed to fetch").includes("Can't reach"));
check("node fetch failed maps to unreachable", friendlyEndpointError("fetch failed").includes("Can't reach"));
check("empty-choices passes through", friendlyEndpointError("AI endpoint returned an empty response.").includes("empty response"));
check("unknown errors pass through", friendlyEndpointError("weird xyz").includes("weird xyz"));

check("429 retries", shouldRetryStatus(429) === true);
check("503 retries", shouldRetryStatus(503) === true);
check("401 fails fast", shouldRetryStatus(401) === false);
check("500 fails fast", shouldRetryStatus(500) === false);

check("cooldown blocks early send", rateLimited(1000, 0, 3000) === true);
check("cooldown allows after window", rateLimited(5000, 0, 3000) === false);
check("zero cooldown never blocks", rateLimited(1000, 999, 0) === false);

console.log(failures === 0 ? "AI-REQUEST-UNIT ALL PASS" : `AI-REQUEST-UNIT ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
