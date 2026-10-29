// Thin client for the radio-browser.info community directory. Runs entirely in
// the browser: the API sends `Access-Control-Allow-Origin: *`, so no backend
// proxy is needed. No key, no account.

const FALLBACK_MIRRORS = [
  "https://de2.api.radio-browser.info",
  "https://nl1.api.radio-browser.info",
  "https://at1.api.radio-browser.info",
];
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_LIMIT = 64;
const searchCache = new Map();
const inFlightSearches = new Map();

let mirror = null;
let mirrorPromise = null;

function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function resolveMirror() {
  if (mirror) return mirror;
  if (mirrorPromise) return mirrorPromise;
  mirrorPromise = (async () => {
    try {
      const res = await timedFetch("https://all.api.radio-browser.info/json/servers", {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error("servers");
      const names = (await res.json()).map(s => s && s.name).filter(Boolean);
      if (!names.length) throw new Error("empty");
      mirror = `https://${names[Math.floor(Math.random() * names.length)]}`;
    } catch {
      mirror = FALLBACK_MIRRORS[Math.floor(Math.random() * FALLBACK_MIRRORS.length)];
    }
    return mirror;
  })();
  return mirrorPromise;
}

async function call(path, params) {
  const qs = params ? "?" + new URLSearchParams(params) : "";
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = await resolveMirror();
    try {
      const res = await timedFetch(`${base}${path}${qs}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error("Radio directory error");
      return await res.json();
    } catch (error) {
      lastError = error;
      mirror = null;
      mirrorPromise = null;
    }
  }
  throw new Error(
    lastError?.name === "AbortError"
      ? "Radio directory request timed out"
      : "Radio directory unavailable",
  );
}

// Map a directory record onto the station shape the rest of the UI uses
// (field names mirror the backend RadioStation / config so they round-trip 1:1).
export function normalizeStation(s) {
  return {
    name: (s.name || "").trim() || "Unknown station",
    url: s.url_resolved || s.url || "",
    favicon: s.favicon || "",
    tags: s.tags || "",
    country: s.countrycode || s.country || "",
    codec: s.codec || "",
    bitrate: Number(s.bitrate) || 0,
    uuid: s.stationuuid || "",
  };
}

export async function searchStations({ name = "", tag = "", country = "", limit = 40 } = {}) {
  const clean = value => String(value || "").trim().replace(/\s+/g, " ");
  const query = {
    name: clean(name),
    tag: clean(tag),
    country: clean(country).toUpperCase(),
    limit: Math.max(1, Math.min(100, Number(limit) || 40)),
  };
  const key = JSON.stringify({
    name: query.name.toLowerCase(),
    tag: query.tag.toLowerCase(),
    country: query.country,
    limit: query.limit,
  });
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    searchCache.delete(key);
    searchCache.set(key, cached);
    return cached.rows.map(station => ({ ...station }));
  }
  if (cached) searchCache.delete(key);
  if (inFlightSearches.has(key)) return (await inFlightSearches.get(key)).map(station => ({ ...station }));

  const params = {
    limit: String(query.limit),
    order: "clickcount",
    reverse: "true",
    hidebroken: "true",
  };
  if (query.name) params.name = query.name;
  if (query.tag) params.tagList = query.tag;
  if (query.country) params.countrycode = query.country;

  const request = call("/json/stations/search", params)
    .then(rows => (Array.isArray(rows) ? rows : []).map(normalizeStation).filter(s => s.url))
    .then(rows => {
      searchCache.set(key, { rows, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
      while (searchCache.size > SEARCH_CACHE_LIMIT) searchCache.delete(searchCache.keys().next().value);
      return rows;
    });
  inFlightSearches.set(key, request);
  try {
    return (await request).map(station => ({ ...station }));
  } finally {
    if (inFlightSearches.get(key) === request) inFlightSearches.delete(key);
  }
}

export function clearSearchCache() {
  searchCache.clear();
}

// Fire-and-forget: bumps the community click counter and resolves the playable URL.
export function registerClick(uuid) {
  if (!uuid) return Promise.resolve(null);
  return call(`/json/url/${encodeURIComponent(uuid)}`).catch(() => null);
}
