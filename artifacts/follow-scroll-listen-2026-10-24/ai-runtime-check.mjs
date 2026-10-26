/**
 * ai-runtime-check.mjs — drive the three Settings → AI & Providers runtime
 * checks (Test STT, Test TTS, Test local model) in the REAL desktop app over
 * WebView2 remote debugging, and report the status text each one leaves
 * behind.
 *
 * Prerequisite: the dev app launched with
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223 --remote-allow-origins=*"
 *
 * Run: node artifacts/follow-scroll-listen-2026-10-24/ai-runtime-check.mjs
 */
const CDP = "http://127.0.0.1:9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickTarget() {
  const list = await (await fetch(`${CDP}/json`)).json();
  const pages = list.filter((t) => t.type === "page");
  const main =
    pages.find((p) => p.title === "Just Write ehis") ||
    pages.find((p) => !/widget|ghost|quick note|:/i.test(p.title)) ||
    pages[0];
  if (!main) throw new Error(`no CDP page targets: ${JSON.stringify(list)}`);
  return main;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? e.type}`));
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { res, rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

const target = await pickTarget();
console.log(`using: ${target.title} @ ${target.url}`);
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");

async function evaluate(expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails.text));
  }
  return r.result?.value;
}

/** Poll a JS expression until it returns a truthy value or we run out of tries. */
async function waitFor(expression, tries, label, ms = 2000) {
  for (let i = 0; i < tries; i++) {
    const v = await evaluate(expression);
    if (v) return v;
    await sleep(ms);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// 1. Open Settings (sidebar gear) and switch to the AI & Providers category.
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('[aria-label="Settings"]')].find(b => b.offsetParent !== null);
  if (!btn) return false;
  btn.click();
  return true;
})()`);
await waitFor(
  `!!document.querySelector('.settings-pane .settings-nav .nav-item')`,
  20,
  "settings pane",
);

await evaluate(`(() => {
  const nav = [...document.querySelectorAll('.settings-nav .nav-item')]
    .find(b => /AI/.test(b.textContent || ''));
  if (!nav) return false;
  nav.click();
  return true;
})()`);
await waitFor(`!!document.querySelector('#test-stt-setup')`, 20, "AI category");

const results = {};
/**
 * Click a Test button, wait for it to fall back to its idle label (the
 * component clears `localModelStatus` while the check runs and writes the
 * verdict when it finishes), then read the status paragraph.
 */
async function runCheck(id, idleLabel, tries, ms) {
  const clicked = await evaluate(`(() => {
    const b = document.querySelector('${id}');
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) {
    results[idleLabel] = `NOT CLICKED (${id} missing or disabled)`;
    return;
  }
  // Done when the button is idle again AND a verdict landed: the component
  // clears the status paragraph while the check runs.
  const done = `(() => {
    const btn = (document.querySelector('${id}')?.textContent || '').trim() === '${idleLabel}';
    const st = (document.querySelector('.settings-content [role="status"]')?.textContent || '').trim();
    return btn && st;
  })()`;
  let ok = false;
  try {
    ok = Boolean(await waitFor(done, tries, `${idleLabel} finishing`, ms));
  } catch (e) {
    results[idleLabel] = `STILL RUNNING / NO STATUS: ${e.message}`;
  }
  if (!ok) return;
  const status = await evaluate(
    `(document.querySelector('.settings-content [role="status"]')?.textContent || '').trim()`,
  );
  results[idleLabel] = status || "no status text";
}

console.log("running Test STT…");
await runCheck("#test-stt-setup", "Test STT", 30, 3000);
console.log("running Test TTS…");
await runCheck("#test-tts-setup", "Test TTS", 30, 3000);
console.log("running Test local model…");
await runCheck("#test-llm-setup", "Test local model", 45, 4000);

// Models folder line + discovered list, to prove the new Documents location.
const modelsFolder = await evaluate(`(() => {
  const el = [...document.querySelectorAll('.settings-content code')].map(n => n.textContent);
  return el.length ? el : [];
})()`);

console.log("\n==== RESULTS");
for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v}`);
console.log(`models-folder code nodes: ${JSON.stringify(modelsFolder)}`);

cdp.close();
process.exit(0);
