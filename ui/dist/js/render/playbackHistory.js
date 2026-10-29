import { el } from "../lib/dom.js";
import { t } from "../i18n.js";

const STORAGE_KEY = "fh6.playback-history.v1";
const HISTORY_LIMIT = 30;

function readHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter(isHistoryEntry).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function isHistoryEntry(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.key === "string" &&
    typeof value.title === "string" &&
    typeof value.source_name === "string"
  );
}

function saveHistory(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Local history remains best-effort if browser storage is unavailable.
  }
}

function responseVersion(response) {
  const version = Number(response?.version);
  return Number.isFinite(version) ? version : 0;
}

export function historyEntryFromState(state) {
  const source = state?.sources?.available?.find(s => s.name === state?.sources?.active);
  const track = state?.track;
  const title = typeof track?.title === "string" ? track.title.trim() : "";
  if (!source || source.playback_state !== "playing" || !title || /^https?:\/\//i.test(title)) {
    return null;
  }
  if (source.name === "online_radio" && !track.artist && !source.details?.song_history?.length) {
    return null;
  }

  const artist = typeof track.artist === "string" ? track.artist.trim() : "";
  const album = typeof track.album === "string" ? track.album.trim() : "";
  const key = [source.name, artist, title, album]
    .map(value => value.toLocaleLowerCase())
    .join("\u0000");
  return {
    key,
    source: source.name,
    source_name: source.display_name || source.name,
    title,
    artist,
    album,
    artwork_url: typeof track.artwork_url === "string" ? track.artwork_url : "",
    played_at: new Date().toISOString(),
  };
}

export function appendHistory(entries, entry, limit = HISTORY_LIMIT) {
  if (!entry) return entries;
  return [entry, ...entries.filter(item => item.key !== entry.key)].slice(0, limit);
}

export function createPlaybackHistory(main, historyApi = {}) {
  let entries = readHistory();
  let latestKey = "";
  let mutationRevision = 0;
  let serverVersion = null;
  let syncing = false;
  let lastSyncAttempt = 0;
  const list = el("ol", { class: "playback-history-list" });
  const clearButton = el(
    "button",
    {
      type: "button",
      class: "btn ghost",
      dataset: { i18n: "playback_history.clear" },
    },
    t("playback_history.clear"),
  );
  const card = el("section", { class: "card playback-history-card", id: "playback-history" }, [
    el("div", { class: "playback-history-head" }, [
      el("h2", { dataset: { i18n: "playback_history.title" } }, t("playback_history.title")),
      clearButton,
    ]),
    list,
  ]);
  main.insertBefore(card, main.firstChild);

  function render() {
    card.hidden = entries.length === 0;
    list.replaceChildren(
      ...entries.map(entry =>
        el("li", { class: "playback-history-item" }, [
          entry.artwork_url
            ? el("img", { src: entry.artwork_url, alt: "", loading: "lazy" })
            : el("span", { class: "playback-history-art", "aria-hidden": "true" }, "♪"),
          el("span", { class: "playback-history-track" }, [
            el("strong", {}, entry.title),
            el("small", {}, [entry.artist, entry.album].filter(Boolean).join(" · ")),
          ]),
          el(
            "span",
            { class: "playback-history-source" },
            [
              entry.source_name,
              entry.played_at
                ? new Date(entry.played_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ]),
      ),
    );
  }

  function applyServerHistory(response, revision) {
    if (revision !== mutationRevision || !Array.isArray(response?.entries)) return;
    serverVersion = responseVersion(response);
    entries = response.entries.filter(isHistoryEntry).slice(0, HISTORY_LIMIT);
    saveHistory(entries);
    render();
  }

  async function syncServerHistory() {
    if (typeof historyApi.getPlaybackHistory !== "function" || syncing) return;
    syncing = true;
    lastSyncAttempt = Date.now();
    const revision = mutationRevision;
    try {
      let response = await historyApi.getPlaybackHistory();
      if (revision !== mutationRevision) return;
      const remoteEntries = Array.isArray(response?.entries)
        ? response.entries.filter(isHistoryEntry)
        : [];
      if (
        remoteEntries.length === 0 &&
        responseVersion(response) === 0 &&
        entries.length > 0 &&
        typeof historyApi.importPlaybackHistory === "function"
      ) {
        response = await historyApi.importPlaybackHistory(entries);
      }
      applyServerHistory(response, revision);
    } catch {
      // Keep local history visible and retry when the server's version changes.
    } finally {
      syncing = false;
    }
  }

  clearButton.addEventListener("click", () => {
    entries = [];
    mutationRevision++;
    saveHistory(entries);
    render();
    if (typeof historyApi.clearPlaybackHistory !== "function") return;
    const revision = mutationRevision;
    historyApi
      .clearPlaybackHistory()
      .then(response => applyServerHistory(response, revision))
      .catch(() => {});
  });

  render();
  void syncServerHistory();
  return {
    update(state) {
      const stateVersion = Number(state?.playback_history_version);
      if (
        Number.isFinite(stateVersion) &&
        (serverVersion === null || stateVersion > serverVersion) &&
        Date.now() - lastSyncAttempt >= 5000
      ) {
        void syncServerHistory();
      }

      const entry = historyEntryFromState(state);
      if (!entry || entry.key === latestKey) return;
      latestKey = entry.key;
      mutationRevision++;
      entries = appendHistory(entries, entry);
      saveHistory(entries);
      render();
      if (typeof historyApi.addPlaybackHistory !== "function") return;

      const revision = mutationRevision;
      historyApi
        .addPlaybackHistory(entry)
        .then(response => applyServerHistory(response, revision))
        .catch(() => {});
    },
    entries: () => [...entries],
  };
}
