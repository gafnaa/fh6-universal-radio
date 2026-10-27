import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderTrackQueue } from "../../dist/js/render/playlistQueue.js";

let trackList;

beforeEach(() => {
  trackList = document.createElement("ul");
  trackList.scrollTo = vi.fn();
});

describe("renderTrackQueue", () => {
  it("only exposes edit controls for upcoming tracks and keeps queue indexes", () => {
    const tracks = [
      { index: 0, title: "Current" },
      { index: 1, title: "Next" },
      { index: 2, title: "Later" },
    ];
    const onMoveTrack = vi.fn();
    const onRemoveTrack = vi.fn();
    const onTrackClick = vi.fn();

    renderTrackQueue(trackList, { cursor: 0, tracks }, "", {
      getTitle: track => track.title,
      getSubtitle: () => null,
      getCoverUrl: () => "",
      getSearchFields: track => [track.title],
      onTrackClick,
      onMoveTrack,
      onRemoveTrack,
    });

    const rows = [...trackList.querySelectorAll("li.track")];
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector(".track-actions")).toBeNull();

    const nextActions = rows[1].querySelectorAll(".track-action");
    expect(nextActions).toHaveLength(3);
    expect(nextActions[0].disabled).toBe(true);
    expect(nextActions[1].disabled).toBe(false);
    expect(nextActions[2].disabled).toBe(false);

    const laterActions = rows[2].querySelectorAll(".track-action");
    expect(laterActions[0].disabled).toBe(false);
    expect(laterActions[1].disabled).toBe(true);

    laterActions[0].click();
    laterActions[2].click();
    expect(onMoveTrack).toHaveBeenCalledWith(tracks[2], 1);
    expect(onRemoveTrack).toHaveBeenCalledWith(tracks[2]);

    rows[0].click();
    expect(onTrackClick).toHaveBeenCalledWith(tracks[0], 0);
  });

  it("shows scanning and error states without a misleading empty-queue row", () => {
    renderTrackQueue(trackList, { cursor: 0, tracks: [], scanning: true }, "", {
      getTitle: track => track.title,
      getSubtitle: () => null,
      getCoverUrl: () => "",
      getSearchFields: () => [],
      onTrackClick: vi.fn(),
    });
    expect(trackList.querySelector(".queue-status")).not.toBeNull();
    expect(trackList.querySelector(".queue-status .spinner")).not.toBeNull();
    expect(trackList.querySelector(".queue-status + li")).toBeNull();

    renderTrackQueue(trackList, { cursor: 0, tracks: [], error: "Could not load queue" }, "", {
      getTitle: track => track.title,
      getSubtitle: () => null,
      getCoverUrl: () => "",
      getSearchFields: () => [],
      onTrackClick: vi.fn(),
    });
    expect(trackList.querySelector(".queue-status.error").textContent).toBe("Could not load queue");
  });
});
