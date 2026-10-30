import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// events.js imports the real API module; stub fetch so getState() resolves with
// a recognizable payload.
const statePayload = { sources: { active: "local_files", available: [] }, track: {} };

let eventSources;

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.closed = false;
    eventSources.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

async function loadConnect() {
  vi.resetModules();
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => statePayload,
  }));
  const mod = await import("../../dist/js/data/events.js");
  return mod.connect;
}

function setHidden(hidden) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

beforeEach(() => {
  eventSources = [];
  globalThis.EventSource = FakeEventSource;
  setHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.EventSource;
});

describe("connect", () => {
  it("uses a single long-lived event stream instead of polling", async () => {
    vi.useFakeTimers();
    const connect = await loadConnect();
    const onState = vi.fn();
    const stop = connect(onState);

    expect(eventSources).toHaveLength(1);
    expect(eventSources[0].url).toBe("/api/events");

    // No timer-driven requests while the stream is healthy.
    await vi.advanceTimersByTimeAsync(5000);
    expect(globalThis.fetch).not.toHaveBeenCalled();

    eventSources[0].emit(statePayload);
    expect(onState).toHaveBeenCalledWith(statePayload);
    stop();
    expect(eventSources[0].closed).toBe(true);
  });

  it("falls back to polling when the stream keeps failing", async () => {
    vi.useFakeTimers();
    const connect = await loadConnect();
    const onState = vi.fn();
    const stop = connect(onState);

    for (let i = 0; i < 3; i++) {
      eventSources.at(-1).onerror?.();
      await vi.advanceTimersByTimeAsync(1000);
    }

    await vi.advanceTimersByTimeAsync(1000);
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith(statePayload);
    stop();
  });

  it("drops the stream while hidden and refreshes once when visible again", async () => {
    const connect = await loadConnect();
    const onState = vi.fn();
    const stop = connect(onState);
    const first = eventSources[0];

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(first.closed).toBe(true);

    const callsWhileHidden = globalThis.fetch.mock.calls.length;
    expect(callsWhileHidden).toBe(0);

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(onState).toHaveBeenCalledWith(statePayload));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(eventSources.length).toBe(2));
    expect(eventSources[1].url).toBe("/api/events");

    stop();
    expect(eventSources[1].closed).toBe(true);
  });
});
