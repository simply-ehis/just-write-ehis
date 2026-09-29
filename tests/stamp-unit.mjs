/**
 * stamp-unit — the place/weather stamp mapping + flow.
 *
 * weatherDesc is a pure table (boundary-checked here), and fetchPlaceStamp
 * runs against stubbed geolocation + fetch: success yields the
 * "📍 <place> · <temp> <sky>" line, denial or dead APIs yield null
 * (never a throw — the daily note must save either way).
 *
 * Run: npm run test:stamp (part of npm run test:source)
 */
import { mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

let geoMode = "ok";
const fakeNavigator = {
  geolocation: {
    getCurrentPosition: (ok, fail) => {
      if (geoMode === "ok") ok({ coords: { latitude: 38.72, longitude: -9.14 } });
      else fail(new Error("denied"));
    },
  },
};
Object.defineProperty(globalThis, "navigator", { value: fakeNavigator, configurable: true });
let wxMode = "ok";
globalThis.fetch = async (url) => {
  if (String(url).includes("nominatim")) {
    return { ok: wxMode === "ok", json: async () => ({ address: { city: "Lisbon" } }) };
  }
  return { ok: wxMode === "ok", json: async () => ({ current: { temperature_2m: 21.4, weathercode: 0 } }) };
};

const esbuild = await import("esbuild");
const outdir = join(root, "tests", ".tmp-stamp");
await mkdir(outdir, { recursive: true });
const outfile = join(outdir, "stamp.mjs");
await esbuild.build({
  entryPoints: [join(root, "src/lib/stamp.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "error",
  alias: { $lib: join(root, "src/lib") },
});
const { weatherDesc, fetchPlaceStamp } = await import(pathToFileURL(outfile).href);

const cases = [
  [0, "clear"], [3, "partly cloudy"], [4, "fog"], [48, "fog"],
  [49, "drizzle"], [57, "drizzle"], [58, "rain"], [67, "rain"],
  [68, "snow"], [77, "snow"], [78, "showers"], [82, "showers"],
  [83, "overcast"], [94, "overcast"], [95, "thunderstorm"], [99, "thunderstorm"],
];
const bad = cases.filter(([code, want]) => weatherDesc(code) !== want);
check(`weather table (${cases.length} boundaries)`, bad.length === 0, JSON.stringify(bad));

geoMode = "ok";
wxMode = "ok";
check("stamp line on success", (await fetchPlaceStamp()) === "📍 Lisbon · 21°C clear");

geoMode = "denied";
check("geolocation denial yields null", (await fetchPlaceStamp()) === null);

geoMode = "ok";
wxMode = "down";
check("dead APIs yield null", (await fetchPlaceStamp()) === null);

// Remove the esbuild scratch bundle — never leave build trash behind.
await rm(join(root, "tests", ".tmp-stamp"), { recursive: true, force: true });
console.log(failures === 0 ? "\nstamp-unit: all checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
