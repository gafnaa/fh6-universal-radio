import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOnlineRadio } from "../../dist/js/render/onlineRadio.js";

const json = body => ({ ok: true, json: async () => body });

beforeEach(() => {
  document.body.innerHTML = "<main></main>";
  localStorage.clear();
  global.fetch = vi.fn(() => Promise.resolve(json({})));
});

afterEach(() => vi.restoreAllMocks());

const ctx = (active, stations = []) => ({
  getState: () => ({
    sources: { active, available: [{ name: "online_radio", playback_state: "stopped" }] },
  }),
  getConfig: () => ({ online_radio: { stations } }),
  onSaved: async () => {},
});

describe("createOnlineRadio", () => {
  it("stays hidden until online_radio is the active source", () => {
    const or = createOnlineRadio(document.querySelector("main"), ctx("spotify"));
    or.render();
    expect(document.getElementById("online-radio-card").hidden).toBe(true);
  });

  it("shows the card and renders saved stations when on air", () => {
    const or = createOnlineRadio(
      document.querySelector("main"),
      ctx("online_radio", [{ name: "Jazz FM", url: "http://jazz.example/stream" }]),
    );
    or.render();
    expect(document.getElementById("online-radio-card").hidden).toBe(false);
    const names = [...document.querySelectorAll(".or-name")].map(n => n.textContent);
    expect(names).toContain("Jazz FM");
  });

  it("shows the empty state with no saved stations", () => {
    const or = createOnlineRadio(document.querySelector("main"), ctx("online_radio", []));
    or.render();
    expect(document.querySelector(".or-empty")).not.toBeNull();
  });

  it("offers My Stations and Discover tabs", () => {
    const or = createOnlineRadio(document.querySelector("main"), ctx("online_radio", []));
    or.render();
    const tabs = [...document.querySelectorAll(".or-tab")].map(t => t.dataset.i18n);
    expect(tabs).toEqual(["online_radio.my_stations", "online_radio.discover"]);
  });
});
