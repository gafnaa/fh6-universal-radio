import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendHistory,
  createPlaybackHistory,
  historyEntryFromState,
} from "../../dist/js/render/playbackHistory.js";

beforeEach(() => {
  document.body.innerHTML = "<main></main>";
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

const stateFor = (title, overrides = {}) => ({
  sources: {
    active: "youtube_music",
    available: [
      { name: "youtube_music", display_name: "YouTube Music", playback_state: "playing" },
    ],
  },
  track: { title, artist: "Artist", album: "Album", artwork_url: "", ...overrides },
});

describe("playback history", () => {
  it("records a track once and keeps playback queues independent", () => {
    const history = createPlaybackHistory(document.querySelector("main"));
    const state = stateFor("Song");
    history.update(state);
    history.update(state);

    expect(history.entries()).toHaveLength(1);
    expect(document.querySelectorAll(".playback-history-item")).toHaveLength(1);
    expect(document.querySelector(".playback-history-item").textContent).toContain("YouTube Music");
  });

  it("moves a repeated track to the front without duplicating it", () => {
    const first = historyEntryFromState(stateFor("First"));
    const second = historyEntryFromState(stateFor("Second"));
    expect(
      appendHistory(appendHistory([first], second), { ...first, played_at: "later" }),
    ).toHaveLength(2);
  });

  it("loads persisted server history and migrates old browser history when needed", async () => {
    const legacy = historyEntryFromState(stateFor("Legacy"));
    localStorage.setItem("fh6.playback-history.v1", JSON.stringify([legacy]));
    const getPlaybackHistory = vi.fn().mockResolvedValue({ entries: [], version: 0 });
    const importPlaybackHistory = vi
      .fn()
      .mockImplementation(async entries => ({ entries, version: 1 }));

    const history = createPlaybackHistory(document.querySelector("main"), {
      getPlaybackHistory,
      importPlaybackHistory,
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(importPlaybackHistory).toHaveBeenCalledWith([legacy]);
    expect(history.entries()).toEqual([legacy]);
  });

  it("does not restore stale browser history after the server records a clear", async () => {
    const legacy = historyEntryFromState(stateFor("Old song"));
    localStorage.setItem("fh6.playback-history.v1", JSON.stringify([legacy]));
    const importPlaybackHistory = vi.fn();
    const history = createPlaybackHistory(document.querySelector("main"), {
      getPlaybackHistory: vi.fn().mockResolvedValue({ entries: [], version: 2 }),
      importPlaybackHistory,
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(importPlaybackHistory).not.toHaveBeenCalled();
    expect(history.entries()).toEqual([]);
  });

  it("sends new tracks to the server once and clears persistent history", async () => {
    const addPlaybackHistory = vi.fn().mockImplementation(async entry => ({
      entries: [entry],
      version: 1,
    }));
    const clearPlaybackHistory = vi.fn().mockResolvedValue({ entries: [], version: 2 });
    const history = createPlaybackHistory(document.querySelector("main"), {
      getPlaybackHistory: vi.fn().mockResolvedValue({ entries: [], version: 0 }),
      addPlaybackHistory,
      clearPlaybackHistory,
    });

    const state = stateFor("Song");
    history.update(state);
    history.update(state);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(addPlaybackHistory).toHaveBeenCalledTimes(1);
    expect(history.entries()).toHaveLength(1);

    document.querySelector(".playback-history-head button").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(clearPlaybackHistory).toHaveBeenCalledTimes(1);
    expect(history.entries()).toEqual([]);
  });

  it("does not record stopped sources or unresolved stream URLs", () => {
    expect(
      historyEntryFromState({ ...stateFor("Song"), sources: { active: "", available: [] } }),
    ).toBeNull();
    expect(historyEntryFromState(stateFor("https://stream.example/live"))).toBeNull();
  });
});
