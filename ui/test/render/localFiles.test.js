import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLocalFiles } from "../../dist/js/render/localFiles.js";

const json = body => ({ ok: true, json: async () => body });

const STATIONS = {
  stations: [
    {
      name: "My Music",
      roots: [],
      excluded: [],
      order: "shuffle",
      grouping: "folder",
      repeat: "all",
    },
  ],
  active_station: "My Music",
  track_count: 0,
};

beforeEach(() => {
  document.body.innerHTML = "<main></main>";
  global.fetch = vi.fn(url => {
    if (url.includes("/stations")) return Promise.resolve(json(STATIONS));
    if (url.includes("/queue")) return Promise.resolve(json({ cursor: 0, tracks: [] }));
    return Promise.resolve(json({}));
  });
});

afterEach(() => vi.restoreAllMocks());

const ctx = active => ({
  getState: () => ({ sources: { active, available: [{ name: "local_files", details: {} }] } }),
  getConfig: () => ({ local_files: { enabled: true } }),
  onSaved: async () => {},
});

describe("createLocalFiles", () => {
  it("stays hidden until local_files is the active source", () => {
    const lf = createLocalFiles(document.querySelector("main"), ctx("spotify"));
    lf.render();
    expect(document.getElementById("local-files-card").hidden).toBe(true);
  });

  it("shows the card and loads stations when local_files is on air", async () => {
    const lf = createLocalFiles(document.querySelector("main"), ctx("local_files"));
    lf.render();
    expect(document.getElementById("local-files-card").hidden).toBe(false);
    await new Promise(r => setTimeout(r, 0));
    const opts = document.querySelectorAll("#local-files-card .stationbar select option");
    expect(opts.length).toBe(1);
    expect(opts[0].textContent).toContain("My Music");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/source/local_files/stations",
      expect.anything(),
    );
  });
});
