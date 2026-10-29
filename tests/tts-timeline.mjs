/**
 * tts-timeline — unit checks for the render-ahead pipeline's pure core:
 * segmentation offsets round-trip into the source snapshot, and the
 * player's timeline math (binary search, page chaining, seek bounds,
 * underrun hold → resume) behaves on every boundary. Phase 4 adds the
 * pill progress % math plus wiring pins for WSOLA live speed.
 *
 * Run: node tests/tts-timeline.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rs = await import(pathToFileURL(join(root, "src/lib/readerSections.ts")).href);
const player = await import(pathToFileURL(join(root, "src/lib/tts/player.ts")).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

// ── Segmentation: offsets round-trip into the source snapshot ────────
{
  const src = [
    "# Chapter One",
    "",
    "First sentence here. Second sentence, with a comma; third one is long enough to need its own line and keeps going.",
    "",
    "- item **bold** and `code`",
    "- second item [link](http://example.com) tail",
    "",
    "A final paragraph. It ends here!",
  ].join("\n");

  const segs = rs.splitSegments(src, { sectionIdx: 3 });
  check("segments produced", segs.length >= 5, `${segs.length} segments`);
  check(
    "every segment ≤ hard cap",
    segs.every((s) => s.text.length <= rs.SEGMENT_MAX_CHARS),
    `cap=${rs.SEGMENT_MAX_CHARS}`,
  );
  let allRoundtrip = true;
  let ordered = true;
  let prevEnd = -1;
  for (const s of segs) {
    const slice = src.slice(s.charStart, s.charEnd);
    if (!norm(rs.stripForTts(slice)).includes(norm(s.text).slice(0, 30))) allRoundtrip = false;
    if (s.charStart < prevEnd) ordered = false;
    prevEnd = s.charEnd;
  }
  check("offsets round-trip into source (strip(slice) ⊇ segment)", allRoundtrip);
  check("offsets advance monotonically", ordered);
  check("sectionIdx carried through", segs.every((s) => s.sectionIdx === 3));

  // Pause classes: every paragraph-final sentence escalates (each
  // paragraph has exactly one); mid-paragraph sentences stay sentence.
  const pauses = new Set(segs.map((s) => s.pauseAfter));
  check("only sentence/paragraph classes from splitSegments", pauses.size >= 1 && [...pauses].every((p) => p === "sentence" || p === "paragraph"), JSON.stringify([...pauses]));
  check("opening heading paragraph-final", segs[0].pauseAfter === "paragraph");
  check("closing sentence paragraph-final", segs[segs.length - 1].pauseAfter === "paragraph");
  check(
    "first sentence of the body stays a sentence pause",
    segs[1].pauseAfter === "sentence",
    segs[1]?.text,
  );

  // Sections: global ids + section-end escalation.
  const secs = rs.segmentsForSections([
    { text: "One two. Go." },
    { text: "Aye. Bee." },
  ]);
  check(
    "global ids are array indexes",
    secs.every((s, i) => s.id === i),
  );
  check(
    "section ends pause like sections",
    secs[1].pauseAfter === "section" && secs[3].pauseAfter === "section",
  );
  check("section indexes carried", secs[2].sectionIdx === 1 && secs[3].sectionIdx === 1);

  // Long-sentence cap splits at commas/spaces, never loses content.
  const long = rs.splitSegments("word, ".repeat(80));
  check(
    "80-comma sentence capped without loss",
    long.length > 1 && long.every((s) => s.text.length <= rs.SEGMENT_MAX_CHARS),
    `${long.length} pieces`,
  );
  const rejoined = long.map((s) => s.text).join(" ");
  const wordCount = (rejoined.match(/word/g) || []).length;
  check("capped pieces keep every word", wordCount === 80, `${wordCount} words`);

  // Selection path: plain text → id === index, sectionIdx -1.
  const plain = rs.segmentsForText("Hello there. Bye now.");
  check(
    "plain-text segments numbered",
    plain.length === 2 && plain[0].id === 0 && plain[1].id === 1 && plain[0].sectionIdx === -1,
  );
}

// ── Timeline math: binary search over SegmentTiming[] ────────────────
{
  const RATE = player.RENDER_SAMPLE_RATE;
  // Synthetic timeline: 10 segments, 24k samples each, 200-sample pauses.
  const timings = [];
  let at = 0;
  for (let i = 0; i < 10; i++) {
    timings.push({ segId: i, startSample: at, endSample: at + 24000 });
    at += 24200;
  }
  check("first segment at 0", player.findSegmentAt(timings, 0) === 0);
  check("before stream → -1", player.findSegmentAt(timings, -1) === -1);
  check("first sample of each segment hits it", timings.every((t, i) => player.findSegmentAt(timings, t.startSample) === i));
  check("last sample of each segment hits it", timings.every((t, i) => player.findSegmentAt(timings, t.endSample - 1) === i));
  check(
    "pause region holds the previous segment",
    timings.every((t, i) => (i === timings.length - 1 ? true : player.findSegmentAt(timings, t.endSample) === i)),
  );
  check("past the end holds the last segment", player.findSegmentAt(timings, timings[9].endSample + 99999) === 9);
  check("empty timings → -1", player.findSegmentAt([], 123) === -1);

  // Page chain: contiguous by construction when pages end/start aligned.
  const pages = [
    { pageIdx: 0, startSample: 0, endSample: 48400, timings: timings.slice(0, 2) },
    { pageIdx: 1, startSample: 48400, endSample: 96800, timings: timings.slice(2, 4) },
    { pageIdx: 2, startSample: 96800, endSample: timings[9].endSample, timings: timings.slice(4) },
  ];
  check("page chain contiguous (0 missing samples)", player.pageChainIsContiguous(pages));
  check("hole detected", !player.pageChainIsContiguous([pages[0], pages[2]]));
  check("page lookup hits", player.findPageFor(pages, 0) === 0 && player.findPageFor(pages, 50000) === 1 && player.findPageFor(pages, timings[9].endSample - 1) === 2);
  check("page lookup misses outside", player.findPageFor(pages, -5) === -1 && player.findPageFor(pages, timings[9].endSample) === -1);
  check("no pages → -1", player.findPageFor([], 10) === -1);

  check("late trim is 0 when early", player.lateTrimSamples(1.0, 0.5, RATE) === 0);
  check("late trim counts elapsed samples", player.lateTrimSamples(1.0, 1.5, RATE) === RATE / 2);

  // ── Underrun hold → resume, demand, end (the failure-mode contract) ──
  const base = { playhead: 0, receivedEnd: 0, readyEnd: 0, totalSamples: 0, renderDone: false, hasPages: false };
  check("no pages yet: not underrun (waiting), demand fires", (() => {
    const d = player.tickDecision({ ...base, playhead: 0, receivedEnd: 0, readyEnd: 0 });
    return !d.underrun && d.demand && !d.ended;
  })());

  check("comfortably inside the frontier: no hold, no demand", (() => {
    const d = player.tickDecision({ ...base, hasPages: true, playhead: 1000, receivedEnd: 500000, readyEnd: 500000 });
    return !d.underrun && !d.demand;
  })());

  check("playhead meets audio frontier → underrun hold", (() => {
    const d = player.tickDecision({ ...base, hasPages: true, playhead: 5000, receivedEnd: 5000, readyEnd: 5000 });
    return d.underrun;
  })());

  check("demand when inside 15 s of the fetch frontier", (() => {
    const d = player.tickDecision({ ...base, hasPages: true, playhead: 350000, receivedEnd: 360000, readyEnd: 360000 });
    return d.demand && !d.underrun;
  })());

  check("page lands → resume clears underrun", (() => {
    const d = player.tickDecision({ ...base, hasPages: true, playhead: 5000, receivedEnd: 300000, readyEnd: 300000 });
    return !d.underrun;
  })());

  check("completed render past last sample (+grace) → ended", (() => {
    const d = player.tickDecision({ ...base, hasPages: true, renderDone: true, playhead: 999999, receivedEnd: 1000000, readyEnd: 1000000, totalSamples: 1000000 });
    return d.ended && !d.underrun && !d.demand;
  })());

  check("underrun impossible once render done", (() => {
    const d = player.tickDecision({ ...base, hasPages: true, renderDone: true, playhead: 999999, receivedEnd: 1000000, readyEnd: 1000000, totalSamples: 1000000 });
    return !d.underrun;
  })());
}

// ── Phase 4: pill progress % + WSOLA live-speed wiring ──────────────
{
  // progressRatio (pure): null until totals exist, clamped at both ends.
  check("progress null until total known", player.progressRatio(5000, 0) === null);
  check("progress = playhead / total", player.progressRatio(30000, 120000) === 0.25);
  check("progress clamps past the end", player.progressRatio(200000, 120000) === 1);
  check("progress clamps below zero", player.progressRatio(-5, 120000) === 0);

  // Wiring pins on both sides of the command (CRLF-safe reads).
  const fs = await import("node:fs/promises");
  const read = async (p) => (await fs.readFile(join(root, p), "utf8")).replace(/\r\n/g, "\n");
  const playerSrc = await read("src/lib/tts/player.ts");
  const btnSrc = await read("src/lib/components/ReadAloudButton.svelte");
  const apiSrc = await read("src/lib/api.ts");
  const renderSrc = await read("src-tauri/src/tts_render.rs");
  const cmdSrc = await read("src-tauri/src/commands.rs");
  const libSrc = await read("src-tauri/src/lib.rs");
  const permSrc = await read("src-tauri/permissions/main.toml");

  check("player emits onProgress from the tick", playerSrc.includes("hooks.onProgress?.(ratio)"));
  check("pill shows progress %", btnSrc.includes("tts-pct") && btnSrc.includes("Math.round($readAloudProgress * 100)"));
  check("pill % driven by audio-clock progress", btnSrc.includes("onProgress: (r) => readAloudProgress.set(r)"));
  check("Ctrl+Shift+Arrow nudges the speed setting", btnSrc.includes("onSpeedKey") && btnSrc.includes('"ArrowUp"') && btnSrc.includes("ttsSpeed = next"));
  check("speed changes push to the live render job", btnSrc.includes("ttsRenderSetSpeed(currentRenderId"));
  check("api binds tts_render_set_speed", apiSrc.includes('"tts_render_set_speed"'));
  // Tauri v2 maps command args to camelCase keys on the JS side; a
  // snake_case key errors with "missing required key streamId". Pin the
  // invoke payloads so this regression can't return silently.
  check("api passes streamId (camelCase) to tts_stream_chunk", apiSrc.includes('("tts_stream_chunk", { streamId })'));
  check("api passes streamId (camelCase) to tts_stream_stop", apiSrc.includes('("tts_stream_stop", { streamId })'));
  check("api passes apiKey (camelCase) to provider_probe", apiSrc.includes('"provider_probe", { endpoint, apiKey })'));
  check("renderer stretches every segment (WSOLA)", renderSrc.includes("wsola_stretch(&pcm, shared.current_speed())"));
  check("synthesis runs at native rate 1.0", renderSrc.replace(/\s+/g, " ").includes("1.0, &params.lang_code,"));
  check("set_speed command defined", cmdSrc.includes("pub fn tts_render_set_speed"));
  check("set_speed registered + permitted", libSrc.includes("commands::tts_render_set_speed") && permSrc.includes("allow-tts-render-set-speed"));
}

// ── Model registry key → on-disk directory mapping (tts_start) ───────
{
  const fs = await import("node:fs/promises");
  const read = async (p) => (await fs.readFile(join(root, p), "utf8")).replace(/\r\n/g, "\n");
  const sidecarSrc = await read("src-tauri/src/sidecar.rs");
  const phononMain = await read("src-tauri/sidecars/phonon-server/src/main.rs");

  check("tts_model_dir joins the registry key under models/", sidecarSrc.includes("fn tts_model_dir(sidecars_dir: &str, model_name: &str)") && sidecarSrc.includes('.join("models")'));
  check("exe path passes the model dir, python keeps the bare name", sidecarSrc.includes("let dir = tts_model_dir(sidecars_dir, name);") && sidecarSrc.includes("is not fetched"));
  check("missing model dir errors actionably", sidecarSrc.includes("fetch_sidecars.py --phonon"));
  check("phonon default dir is the registry key", phononMain.includes('models.join("phonon-31m-en")'));
  check("phonon legacy models/phonon still resolves", phononMain.includes("legacy") && phononMain.includes('models.join("phonon")'));
}

console.log(failures === 0 ? "\nTTS-TIMELINE ALL PASS" : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
