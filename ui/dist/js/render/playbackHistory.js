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

export function createPlaybackHistory(main) {
  let entries = readHistory();
  let latestKey = "";
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

  clearButton.addEventListener("click", () => {
    entries = [];
    latestKey = "";
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Local history is best-effort if storage is unavailable.
    }
    render();
  });

  render();
  return {
    update(state) {
      const entry = historyEntryFromState(state);
      if (!entry || entry.key === latestKey) return;
      latestKey = entry.key;
      entries = appendHistory(entries, entry);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      } catch {
        // Local history is best-effort if storage is unavailable.
      }
      render();
    },
    entries: () => [...entries],
  };
}
