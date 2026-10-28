import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "../../dist/js/data/api.js";

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
});

afterEach(() => vi.restoreAllMocks());

describe("station queue API", () => {
  it("searches songs and queues a selected YouTube result", async () => {
    await api.youtubeMusic.searchSongs("Daft Punk One More Time");
    expect(global.fetch).toHaveBeenLastCalledWith("/api/source/youtube_music/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Daft Punk One More Time" }),
    });

    await api.youtubeMusic.addSearchResult({ id: "dQw4w9WgXcQ", title: "Song", artist: "Artist" });
    expect(global.fetch).toHaveBeenLastCalledWith("/api/source/youtube_music/queue/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "dQw4w9WgXcQ", title: "Song", artist: "Artist" }),
    });
  });

  it("sends queue reorder and remove operations to each source endpoint", async () => {
    await api.localFiles.moveQueueItem(4, 2);
    expect(global.fetch).toHaveBeenLastCalledWith("/api/source/local_files/queue/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: 4, to: 2 }),
    });

    await api.youtubeMusic.removeQueueItem(3);
    expect(global.fetch).toHaveBeenLastCalledWith("/api/source/youtube_music/queue/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: 3 }),
    });

    await api.jellyfin.moveQueueItem(5, 1);
    expect(global.fetch).toHaveBeenLastCalledWith("/api/source/jellyfin/queue/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: 5, to: 1 }),
    });
  });

  it("can save YouTube Music and Jellyfin queues as stations", async () => {
    await api.youtubeMusic.saveQueueAsStation("Road Trip");
    expect(global.fetch).toHaveBeenLastCalledWith("/api/source/youtube_music/queue/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Road Trip" }),
    });

    await api.jellyfin.saveQueueAsStation("Favorites Mix");
    expect(global.fetch).toHaveBeenLastCalledWith("/api/source/jellyfin/queue/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Favorites Mix" }),
    });
  });
});
