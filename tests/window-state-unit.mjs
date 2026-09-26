/**
 * window-state-unit — checks for src/lib/windowState.ts, the main-window
 * geometry behind "first launch ≈80% of the work area, later launches
 * restore the user's size/position".
 *
 * Run: node tests/window-state-unit.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = await import(pathToFileURL(join(root, "src/lib/windowState.ts")).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const area1080p = { x: 0, y: 0, w: 1920, h: 1040 }; // 1080p minus taskbar

// Fresh launch covers 80% and centers inside the work area.
let d = v.defaultGeometry(area1080p);
check("default is 80% of work area", d.w === 1536 && d.h === 832, JSON.stringify(d));
check(
  "default centered",
  d.x === Math.round((1920 - 1536) / 2) && d.y === Math.round((1040 - 832) / 2),
  JSON.stringify(d)
);
check(
  "default stays inside work area",
  d.x >= 0 && d.y >= 0 && d.x + d.w <= 1920 && d.y + d.h <= 1040
);

// Tiny work area (smaller than the window minimums): cover the work area
// rather than spilling past it — minimums must never push past the taskbar.
d = v.defaultGeometry({ x: 0, y: 0, w: 800, h: 500 });
check("small screen fills work area, never spills", d.w === 800 && d.h === 500 && d.x === 0 && d.y === 0, JSON.stringify(d));

// Taskbar offset (availTop) is respected, not overlapped.
d = v.defaultGeometry({ x: 0, y: 40, w: 1366, h: 688 });
check("work-area origin respected", d.y >= 40 && d.x >= 0, JSON.stringify(d));
check("fits below the taskbar strip", d.y + d.h <= 40 + 688, JSON.stringify(d));

// Saved geometry restores verbatim when it still fits.
const saved = { w: 1200, h: 700, x: 100, y: 80 };
let c = v.coerceGeometry(saved, area1080p);
check("saved geometry restores", c && c.w === 1200 && c.h === 700 && c.x === 100 && c.y === 80);

// Off-screen saves (unplugged monitor) clamp back on-screen.
c = v.coerceGeometry({ w: 1200, h: 700, x: 5000, y: -200 }, area1080p);
check("off-screen position clamps inside", c !== null && c.x + 120 <= 1920 && c.y >= 0, JSON.stringify(c));

// Oversized saves shrink to the current work area.
c = v.coerceGeometry({ w: 4000, h: 3000, x: 0, y: 0 }, area1080p);
check("oversized save shrinks to fit", c !== null && c.w <= 1920 && c.h <= 1040, JSON.stringify(c));

// Garbage saves fall back to the default, never throw.
check("null save rejected", v.coerceGeometry(null, area1080p) === null);
check("string save rejected", v.coerceGeometry("big", area1080p) === null);
check("NaN save rejected", v.coerceGeometry({ w: NaN, h: 700, x: 0, y: 0 }, area1080p) === null);
c = v.computeWindowTarget(area1080p, { nope: true });
check("compute falls back to default", c.w === 1536 && c.h === 832, JSON.stringify(c));
c = v.computeWindowTarget(area1080p, saved);
check("compute prefers saved", c.w === 1200 && c.x === 100, JSON.stringify(c));

if (failures > 0) {
  console.error(`window-state-unit: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("window-state-unit: all checks passed");
