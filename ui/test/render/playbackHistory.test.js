import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("does not record stopped sources or unresolved stream URLs", () => {
    expect(
      historyEntryFromState({ ...stateFor("Song"), sources: { active: "", available: [] } }),
    ).toBeNull();
    expect(historyEntryFromState(stateFor("https://stream.example/live"))).toBeNull();
  });
});
