import { api } from "./api.js";

// Live state via SSE, falling back to polling /api/state. Returns a stop fn.
//
// The server keeps the stream open and only pushes when the snapshot actually
// changes, so an idle dashboard costs one connection and no traffic. A hidden
// tab drops the stream entirely (browsers throttle background timers anyway)
// and reconnects with a single fetch when it becomes visible again.
export function connect(onState) {
  let stopped = false;
  let polling = false;
  let timer = null;
  let source = null;
  let failures = 0;

  const poll = async () => {
    if (stopped) return;
    // While hidden the visibility handler owns the restart, so the chain stops
    // instead of waking up every couple of seconds for a page nobody sees.
    if (document.hidden) return;
    try {
      onState(await api.getState());
      failures = 0;
    } catch {
      // keep last state
      failures++;
    }
    // Poll faster right after a failure so a restarting backend recovers
    // quickly, then back off to the steady interval.
    timer = setTimeout(poll, failures > 3 ? 5000 : 1000);
  };

  const startPolling = () => {
    if (polling || stopped) return;
    polling = true;
    poll();
  };

  const startStream = () => {
    if (stopped || document.hidden) return;
    try {
      source = new EventSource("/api/events");
    } catch {
      startPolling();
      return;
    }
    source.onmessage = e => {
      failures = 0;
      try {
        onState(JSON.parse(e.data));
      } catch {
        // ignore a malformed frame and wait for the next one
      }
    };
    source.onerror = () => {
      source?.close?.();
      source = null;
      // EventSource retries on its own, but a closed server connection would
      // loop forever; poll instead so the dashboard still updates.
      if (++failures >= 3) startPolling();
      else setTimeout(startStream, 1000);
    };
  };

  const onVisibility = () => {
    if (document.hidden) {
      clearTimeout(timer);
      source?.close?.();
      source = null;
      return;
    }
    // Coming back: refresh once immediately, then resume whichever transport
    // was active. The poll chain was cancelled while hidden, so restart it.
    api
      .getState()
      .then(onState)
      .catch(() => {})
      .finally(() => {
        if (polling) {
          clearTimeout(timer);
          poll();
        } else {
          startStream();
        }
      });
  };

  document.addEventListener("visibilitychange", onVisibility);
  startStream();

  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close?.();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
