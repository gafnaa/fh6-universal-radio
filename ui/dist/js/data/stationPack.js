// Station packs are portable curated sources and frozen queues. Machine-specific
// Local Files roots, credentials, and Jellyfin playlists are intentionally omitted.
const PACK_SECTIONS = ["youtube_music", "jellyfin", "online_radio"];

export function buildStationPack(cfg) {
  const pack = { _meta: { type: "fh6-radio-station-pack", version: 2 } };
  for (const section of PACK_SECTIONS) {
    const stations = cfg?.[section]?.stations || [];
    pack[section] = {
      stations:
        section === "jellyfin"
          ? stations.filter(
              st =>
                !st.playlist_id &&
                !st.use_favorites &&
                Array.isArray(st.tracks) &&
                st.tracks.length,
            )
          : stations,
    };
  }
  return pack;
}

function stationIdentity(station) {
  if (station.url) return `url:${station.url}`;
  if (station.uuid) return `uuid:${station.uuid}`;
  if (station.playlist_id) return `playlist:${station.playlist_id}`;
  if (station.use_favorites) return "favorites";
  if (Array.isArray(station.tracks) && station.tracks.length) {
    return `tracks:${station.tracks
      .map(track => track?.id || "")
      .filter(Boolean)
      .join("\u0000")}`;
  }
  return `name:${(station.name || "").trim().toLocaleLowerCase()}`;
}

/**
 * Merge a station pack into the current config, skipping duplicates by stable
 * URL/provider ID or frozen queue contents. Returns a source-specific patch.
 */
export function mergeStationPack(cfg, pack) {
  const patch = {};
  let added = 0;
  for (const section of PACK_SECTIONS) {
    const existing = cfg?.[section]?.stations || [];
    const incoming = Array.isArray(pack?.[section]?.stations) ? pack[section].stations : [];
    const identities = new Set(existing.filter(Boolean).map(stationIdentity));
    const fresh = incoming.filter(station => {
      if (!station || typeof station !== "object") return false;
      if (
        section === "jellyfin" &&
        (station.playlist_id ||
          station.use_favorites ||
          !Array.isArray(station.tracks) ||
          !station.tracks.length)
      ) {
        return false;
      }
      const identity = stationIdentity(station);
      if (identities.has(identity)) return false;
      identities.add(identity);
      return true;
    });
    added += fresh.length;
    patch[section] = { stations: [...existing, ...fresh] };
  }
  return { patch, added };
}
