import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchStations } from "../../dist/js/data/radioBrowser.js";

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("radio directory search", () => {
  it("sends genre chips to the tag search field and normalizes playable results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ name: "de2.api.radio-browser.info" }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              name: "Jazz FM",
              url: "http://radio.example/stream",
              url_resolved: "https://radio.example/live",
              tags: "jazz,soul",
              countrycode: "US",
              bitrate: "128",
              stationuuid: "station-1",
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const stations = await searchStations({ tag: "jazz", country: "US", limit: 25 });
    expect(fetchMock.mock.calls[1][0]).toContain("tagList=jazz");
    expect(fetchMock.mock.calls[1][0]).toContain("countrycode=US");
    expect(stations[0]).toMatchObject({
      name: "Jazz FM",
      url: "https://radio.example/live",
      tags: "jazz,soul",
      country: "US",
      bitrate: 128,
      uuid: "station-1",
    });
  });
});
