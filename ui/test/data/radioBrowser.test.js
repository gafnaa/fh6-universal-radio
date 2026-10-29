import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSearchCache, searchStations } from "../../dist/js/data/radioBrowser.js";

beforeEach(() => {
  vi.unstubAllGlobals();
  clearSearchCache();
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

  it("coalesces in-flight equivalent searches and caches successful results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ name: "Lo-Fi Radio", url: "https://radio.example/lofi" }]), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [first, sameSearch] = await Promise.all([
      searchStations({ name: "  Lo-Fi   Radio ", country: "us" }),
      searchStations({ name: "lo-fi radio", country: "US" }),
    ]);
    await searchStations({ name: "LO-FI RADIO", country: "US" });

    const searchCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/json/stations/search"),
    );
    expect(searchCalls).toHaveLength(1);
    expect(first).toEqual(sameSearch);
    expect(first).not.toBe(sameSearch);
  });

  it("expires cached results after five minutes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ name: "Jazz", url: "https://radio.example/jazz" }]), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await searchStations({ name: "jazz" });
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    await searchStations({ name: "jazz" });

    const searchCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/json/stations/search"),
    );
    expect(searchCalls).toHaveLength(2);
    vi.useRealTimers();
  });
});
