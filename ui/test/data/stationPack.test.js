import { describe, expect, it } from "vitest";
import { buildStationPack, mergeStationPack } from "../../dist/js/data/stationPack.js";

describe("station packs", () => {
  it("exports transferable stations and frozen cross-provider queues, not machine-specific sources", () => {
    const pack = buildStationPack({
      local_files: { stations: [{ name: "Private", roots: ["C:/Music"] }] },
      youtube_music: { stations: [{ name: "YT queue", tracks: [{ id: "video-1" }] }] },
      jellyfin: {
        stations: [
          { name: "Server playlist", playlist_id: "playlist-1" },
          { name: "Saved queue", tracks: [{ id: "item-1" }] },
        ],
      },
      online_radio: { stations: [{ name: "Jazz", url: "https://radio.example/live" }] },
    });

    expect(pack.youtube_music.stations).toHaveLength(1);
    expect(pack.jellyfin.stations).toEqual([{ name: "Saved queue", tracks: [{ id: "item-1" }] }]);
    expect(pack.online_radio.stations).toHaveLength(1);
    expect(pack.local_files).toBeUndefined();
  });

  it("merges multiple source sections once and skips duplicates", () => {
    const current = {
      youtube_music: { stations: [{ name: "Existing", url: "https://youtube.example/list" }] },
      jellyfin: { stations: [{ name: "Saved", tracks: [{ id: "item-1" }] }] },
      online_radio: { stations: [{ name: "Jazz", url: "https://radio.example/live" }] },
    };
    const pack = {
      youtube_music: {
        stations: [
          { name: "Existing copy", url: "https://youtube.example/list" },
          { name: "New queue", tracks: [{ id: "video-2" }] },
        ],
      },
      jellyfin: {
        stations: [
          { name: "Saved copy", tracks: [{ id: "item-1" }] },
          { name: "New saved queue", tracks: [{ id: "item-2" }] },
          { name: "Server playlist", playlist_id: "playlist-2" },
        ],
      },
      online_radio: {
        stations: [
          { name: "Jazz copy", url: "https://radio.example/live" },
          { name: "Rock", url: "https://radio.example/rock" },
        ],
      },
    };

    const result = mergeStationPack(current, pack);
    expect(result.added).toBe(3);
    expect(result.patch.youtube_music.stations).toHaveLength(2);
    expect(result.patch.jellyfin.stations).toHaveLength(2);
    expect(result.patch.online_radio.stations).toHaveLength(2);
  });
});
