import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderTrackQueue } from "../../dist/js/render/playlistQueue.js";

const baseOpts = extra => ({
  getTitle: track => track.title,
  getSubtitle: () => null,
  getCoverUrl: () => "",
  getSearchFields: track => [track.title],
  onTrackClick: vi.fn(),
  ...extra,
});

function tracks(count) {
  return Array.from({ length: count }, (_, i) => ({ index: i, title: `Track ${i}` }));
}

describe("renderTrackQueue windowing", () => {
  let trackList;

  beforeEach(() => {
    trackList = document.createElement("ul");
    trackList.scrollTo = vi.fn();
  });

  it("caps the DOM rows for a huge queue and grows on demand", () => {
    renderTrackQueue(trackList, { cursor: 0, tracks: tracks(2000) }, "", baseOpts({}));

    const rendered = trackList.querySelectorAll("li.track").length;
    expect(rendered).toBe(150);
    expect(trackList.querySelector(".queue-more")).not.toBeNull();

    trackList.querySelector(".queue-more button").click();
    expect(trackList.querySelectorAll("li.track").length).toBe(300);
  });

  it("keeps the current track inside the window when the queue is far along", () => {
    renderTrackQueue(trackList, { cursor: 1200, tracks: tracks(2000) }, "", baseOpts({}));

    expect(trackList.querySelector(".track.current")).not.toBeNull();
    expect(trackList.querySelectorAll("li.track").length).toBe(1350);
  });

  it("resets the window when the filter changes", () => {
    renderTrackQueue(trackList, { cursor: 0, tracks: tracks(400) }, "", baseOpts({}));
    trackList.querySelector(".queue-more button").click();
    expect(trackList.querySelectorAll("li.track").length).toBe(300);

    renderTrackQueue(trackList, { cursor: 0, tracks: tracks(400) }, "Track 1", baseOpts({}));
    expect(trackList.querySelectorAll("li.track").length).toBeLessThanOrEqual(150);
  });
});

describe("renderTrackQueue drag and drop", () => {
  let trackList;

  beforeEach(() => {
    trackList = document.createElement("ul");
    trackList.scrollTo = vi.fn();
  });

  it("makes only upcoming rows draggable", () => {
    renderTrackQueue(
      trackList,
      { cursor: 1, tracks: tracks(4) },
      "",
      baseOpts({ onMoveTrack: vi.fn() }),
    );

    const rows = [...trackList.querySelectorAll("li.track")];
    expect(rows[0].draggable).toBe(false);
    expect(rows[1].draggable).toBe(false);
    expect(rows[2].draggable).toBe(true);
    expect(rows[3].draggable).toBe(true);
  });

  it("moves a dragged row onto the drop target index", () => {
    const onMoveTrack = vi.fn();
    renderTrackQueue(trackList, { cursor: 0, tracks: tracks(4) }, "", baseOpts({ onMoveTrack }));

    const rows = [...trackList.querySelectorAll("li.track")];
    const store = {};
    const transfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: (type, value) => {
        store[type] = value;
      },
      getData: type => store[type] ?? "",
    };

    rows[3].dispatchEvent(
      Object.assign(new Event("dragstart", { bubbles: true }), { dataTransfer: transfer }),
    );
    rows[1].dispatchEvent(
      Object.assign(new Event("drop", { bubbles: true }), { dataTransfer: transfer }),
    );

    expect(onMoveTrack).toHaveBeenCalledWith({ index: 3 }, 1);
  });

  it("ignores a drop on the row it started from", () => {
    const onMoveTrack = vi.fn();
    renderTrackQueue(trackList, { cursor: 0, tracks: tracks(4) }, "", baseOpts({ onMoveTrack }));

    const rows = [...trackList.querySelectorAll("li.track")];
    const transfer = {
      setData: () => {},
      getData: () => "2",
    };
    rows[2].dispatchEvent(
      Object.assign(new Event("drop", { bubbles: true }), { dataTransfer: transfer }),
    );
    expect(onMoveTrack).not.toHaveBeenCalled();
  });
});
