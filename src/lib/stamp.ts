/**
 * stamp — optional location + weather line for new daily notes (A11.9).
 * Opt-in, keyless free APIs (Nominatim + Open-Meteo), fails silent.
 */

function geoPosition(timeoutMs = 8000): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("no geolocation"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: timeoutMs });
  });
}

function weatherDesc(code: number): string {
  if (code === 0) return "clear";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "showers";
  if (code >= 95) return "thunderstorm";
  return "overcast";
}

/** "📍 Lisbon · 21°C clear" or null when anything is unavailable/denied. */
export async function fetchPlaceStamp(): Promise<string | null> {
  try {
    const pos = await geoPosition();
    const { latitude, longitude } = pos.coords;
    const [rev, wx] = await Promise.all([
      fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=jsonv2`,
        { headers: { Accept: "application/json" } }
      ).then((r) => (r.ok ? r.json() : null)),
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weathercode`
      ).then((r) => (r.ok ? r.json() : null)),
    ]);
    const addr = rev?.address ?? {};
    const place = addr.city ?? addr.town ?? addr.village ?? addr.suburb ?? addr.state ?? null;
    const cur = wx?.current;
    const parts: string[] = [];
    if (place) parts.push(String(place));
    if (typeof cur?.temperature_2m === "number") {
      const w = typeof cur?.weathercode === "number" ? ` ${weatherDesc(cur.weathercode)}` : "";
      parts.push(`${Math.round(cur.temperature_2m)}°C${w}`);
    }
    if (parts.length === 0) return null;
    return `📍 ${parts.join(" · ")}`;
  } catch {
    return null;
  }
}
