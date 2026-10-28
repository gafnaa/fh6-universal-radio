import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createYoutubeMusic } from "../../dist/js/render/youtubeMusic.js";

const json = body => ({ ok: true, json: async () => body });

beforeEach(() => {
  document.body.innerHTML = "<main></main>";
  global.fetch = vi.fn(url => {
    if (url === "/api/source/youtube_music/search") {
      return Promise.resolve(
        json({
          results: [
            {
              id: "dQw4w9WgXcQ",
              title: "One More Time",
              artist: "Daft Punk",
              thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
              duration_ms: 320000,
            },
          ],
        }),
      );
    }
    if (url === "/api/source/youtube_music/stations") {
      return Promise.resolve(json({ stations: [], active_station: "" }));
    }
    if (url === "/api/source/youtube_music/queue") {
      return Promise.resolve(json({ cursor: 0, tracks: [] }));
    }
    return Promise.resolve(json({}));
  });
});

afterEach(() => vi.restoreAllMocks());

describe("YouTube Music song search", () => {
  it("renders search results and adds a selected song to the queue", async () => {
    const ctx = {
      getState: () => ({
        sources: {
          active: "youtube_music",
          available: [{ name: "youtube_music", details: {} }],
        },
      }),
      getConfig: () => ({ youtube_music: {} }),
      onSaved: async () => {},
    };
    const ui = createYoutubeMusic(document.querySelector("main"), ctx);
    ui.render();

    const search = document.querySelector("#youtube-music-card input[type=search]");
    search.value = "Daft Punk One More Time";
    search.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    const result = document.querySelector(".youtube-search-result");
    expect(result.textContent).toContain("One More Time");
    expect(result.textContent).toContain("Daft Punk");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/source/youtube_music/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "Daft Punk One More Time" }),
      }),
    );

    result.querySelector(".youtube-search-result__actions button:first-child").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/source/youtube_music/cast",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
      }),
    );

    result.querySelector(".youtube-search-result__actions button:last-child").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/source/youtube_music/queue/add",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id: "dQw4w9WgXcQ", title: "One More Time", artist: "Daft Punk" }),
      }),
    );
  });
});
