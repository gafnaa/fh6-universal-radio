import { api } from "../data/api.js";
import { $, el } from "../lib/dom.js";
import { icons } from "../icons.js";
import { toast } from "../toast.js";
import { t } from "../i18n.js";
import { fmt } from "../lib/format.js";
import { createStationManager } from "./stationManager.js";

/**
 * Creates a default station object structure.
 *
 * @param {string} name - The name of the station
 * @returns {object} The new station instance { name, url }
 */
function newStation(name) {
    return { name, url: "" };
}

/**
 * Renders and manages the YouTube Music station source UI component.
 * Integrates with the shared StationManager for CRUD operations and track queues.
 *
 * @param {HTMLElement} main - The main container element to inject the card into
 * @param {object} ctx - Application context containing state and lifecycle hooks
 * @param {() => object} ctx.getState - Returns the global application state
 * @param {() => Promise<void>} [ctx.onSaved] - Optional callback triggered after successful mutations
 */
export function createYoutubeMusic(main, ctx) {
    const songSearchInput = el("input", {
        type: "search", class: "path-input",
        placeholder: t("youtube_music.search_placeholder"),
        dataset: { i18nPlaceholder: "youtube_music.search_placeholder" },
        autocomplete: "off",
    });
    const searchBtn = el("button", {
        type: "submit", class: "btn filled", dataset: { i18n: "youtube_music.search" },
    }, t("youtube_music.search"));
    const searchForm = el("form", { class: "row youtube-search-form" }, [songSearchInput, searchBtn]);
    const searchStatus = el("p", { class: "muted", role: "status", "aria-live": "polite", hidden: true });
    const searchResults = el("div", { class: "youtube-search-results", hidden: true });
    const urlInput = el("input", { type: "text", class: "path-input", placeholder: "https://music.youtube.com/playlist?list=...", autocomplete: "off" });
    const castBtn = el("button", { type: "button", class: "btn ghost", dataset: { i18n: "btn.cast" } }, t("btn.cast"));
    const saveBtn = el("button", { type: "button", class: "btn filled", dataset: { i18n: "btn.save" } }, t("btn.save"));
    const shuffleBtn = el("button", {
        type: "button", class: "icon-btn", "aria-label": "Toggle Shuffle",
        dataset: { i18nAriaLabel: "youtube_music.shuffle" }, html: icons.shuffle,
    });
    const summaryEl = el("p", { class: "muted", hidden: true });
    const exportBtn = el("button", {
        type: "button", class: "btn ghost", title: t("settings.export_stations_title"),
        dataset: { i18n: "settings.export_stations", i18nTitle: "settings.export_stations_title" },
    }, t("settings.export_stations"));
    const importBtn = el("button", {
        type: "button", class: "btn ghost", title: t("settings.import_stations_title"),
        dataset: { i18n: "settings.import_stations", i18nTitle: "settings.import_stations_title" },
    }, t("settings.import_stations"));
    const importFileInput = el("input", { type: "file", accept: ".json", hidden: true });
    const oauthStatus = el("p", { class: "muted" }, t("youtube_music.not_connected"));
    const oauthHint = el("p", { class: "muted" }, t("youtube_music.oauth_setup"));
    const connectBtn = el("button", { type: "button", class: "btn filled", dataset: { i18n: "youtube_music.connect_google" } }, t("youtube_music.connect_google"));
    const discoverBtn = el("button", { type: "button", class: "btn ghost", disabled: true, dataset: { i18n: "youtube_music.find_playlists" } }, t("youtube_music.find_playlists"));
    const disconnectBtn = el("button", { type: "button", class: "btn ghost", hidden: true, dataset: { i18n: "youtube_music.disconnect" } }, t("youtube_music.disconnect"));
    const playlistStatus = el("p", { class: "muted", hidden: true });
    const playlistList = el("div", { class: "youtube-playlist-list", hidden: true });
    const importSelectedBtn = el("button", { type: "button", class: "btn filled", disabled: true, dataset: { i18n: "youtube_music.import_selected" } }, t("youtube_music.import_selected"));
    const selectedCount = el("span", { class: "muted" });
    let oauthConnected = false;
    let oauthChecked = false;
    let oauthStarting = false;
    let discoveredPlaylists = [];
    const selectedPlaylistIds = new Set();
    let lastDetails = null;

    function renderSummary() {
        const s = station.cur();
        if (!s) {
            summaryEl.hidden = true;
            return;
        }
        const isOnAir = s.name === station.getActiveStation();
        const trackCount = isOnAir ? lastDetails?.queue_size : null;

        const parts = [`${stationSelect.options.length} ${t("label.stations")}`];
        if (trackCount != null) parts.unshift(`${trackCount} ${t("label.tracks")}`);

        summaryEl.textContent = parts.join(", ");
        summaryEl.hidden = false;
    }

    const station = createStationManager({
        api: api.youtubeMusic,
        newStation,
        defaultNameKey: "youtube_music.default_station_name",
        ctx,
        queue: {
            getTitle: track => track.title || track.url?.split("v=")[1] || track.url,
            getSubtitle: track => (track.url ? (track.url.split("v=")[1] || track.url) : null),
            getCoverUrl: track => track.cover_url,
            getSearchFields: track => [track.title || "", track.url || ""],
        },
        getSig: details => `${details?.queue_size ?? -1}|${details?.queue_cursor ?? -1}|${details?.queue_scanning ? 1 : 0}|${details?.queue_error ?? ""}`,
        onAir: async () => {
            await api.switchSource("youtube_music");
            await api.transport("youtube_music", "play");
        },
        onStationChange: s => {
            urlInput.value = s?.url || "";
            renderSummary();
        },
        onSync: details => {
            lastDetails = details;
            const shuffleOn = !!details?.shuffle;
            shuffleBtn.classList.toggle("toggled", shuffleOn);
            shuffleBtn.setAttribute("aria-pressed", String(shuffleOn));
            renderSummary();
        },
    });

    const { stationSelect, onAirBtn, newBtn, duplicateBtn, renameBtn, deleteBtn, queueCount, saveQueueBtn, searchInput, trackList } = station.els;

    const card = el("section", { class: "card", id: "youtube-music-card", hidden: true }, [
        el("h2", { dataset: { i18n: "youtube_music.title" } }, t("youtube_music.title")),
        summaryEl,
        el("div", { class: "stationbar row" }, [stationSelect, onAirBtn]),
        el("div", { class: "row stationtools" }, [newBtn, duplicateBtn, renameBtn, deleteBtn]),
        el("div", { class: "row stationtools" }, [exportBtn, importBtn]),
        importFileInput,
        el("div", { class: "editor youtube-search" }, [
            el("label", { class: "field-label", dataset: { i18n: "youtube_music.search_songs" } }, t("youtube_music.search_songs")),
            searchForm,
            searchStatus,
            searchResults,
        ]),
        el("div", { class: "youtube-oauth editor" }, [
            el("h3", { dataset: { i18n: "youtube_music.account_playlists" } }, t("youtube_music.account_playlists")),
            oauthHint,
            el("div", { class: "row stationtools" }, [connectBtn, discoverBtn, disconnectBtn]),
            oauthStatus,
            playlistStatus,
            playlistList,
            el("div", { class: "row stationtools" }, [selectedCount, importSelectedBtn]),
        ]),
        el("div", { class: "editor" }, [
            el("label", { class: "field-label", dataset: { i18n: "youtube_music.playlist_or_video_url" } }, t("youtube_music.playlist_or_video_url")),
            urlInput,
            el("div", { class: "row editor-foot" }, [castBtn, saveBtn]),
        ]),
        el("div", { class: "queue" }, [
            el("div", { class: "queue-head row" }, [el("label", { class: "field-label", dataset: { i18n: "label.queue" } }, t("label.queue")), queueCount, saveQueueBtn, shuffleBtn]),
            searchInput,
            trackList,
        ]),
    ]);

    const sourcesCard = $("#sources", main)?.closest(".card");
    if (sourcesCard) sourcesCard.insertAdjacentElement("afterend", card);
    else main.append(card);

    function renderSearchResults(results) {
        searchResults.replaceChildren(...results.map(result => {
            const details = [result.artist, result.duration_ms ? fmt(result.duration_ms) : ""]
                .filter(Boolean)
                .join(" · ");
            const playBtn = el("button", {
                type: "button", class: "btn ghost", dataset: { i18n: "youtube_music.play_result" },
            }, t("youtube_music.play_result"));
            const addBtn = el("button", {
                type: "button", class: "btn filled", dataset: { i18n: "youtube_music.add_to_queue" },
            }, t("youtube_music.add_to_queue"));
            playBtn.addEventListener("click", async () => {
                playBtn.disabled = true;
                try {
                    await api.youtubeMusic.cast(`https://www.youtube.com/watch?v=${encodeURIComponent(result.id)}`);
                    toast(t("toast.casting", { service: "YouTube Music" }));
                    await ctx.onSaved?.();
                    await station.loadQueue();
                } catch (e) {
                    toast(e.message, true);
                } finally {
                    playBtn.disabled = false;
                }
            });
            addBtn.addEventListener("click", async () => {
                addBtn.disabled = true;
                try {
                    await api.youtubeMusic.addSearchResult(result);
                    await ctx.onSaved?.();
                    await station.loadQueue();
                    toast(t("youtube_music.added_to_queue", { title: result.title }));
                } catch (e) {
                    toast(e.message, true);
                } finally {
                    addBtn.disabled = false;
                }
            });

            return el("article", { class: "youtube-search-result" }, [
                el("img", {
                    class: "youtube-search-cover", src: result.thumbnail_url || "", alt: "",
                    loading: "lazy", "aria-hidden": "true",
                }),
                el("div", { class: "youtube-search-result__meta" }, [
                    el("strong", {}, result.title || t("label.unknown_title")),
                    details ? el("small", {}, details) : null,
                ]),
                el("div", { class: "youtube-search-result__actions" }, [playBtn, addBtn]),
            ]);
        }));
        searchResults.hidden = results.length === 0;
    }

    searchForm.addEventListener("submit", async event => {
        event.preventDefault();
        const query = songSearchInput.value.trim();
        if (!query) {
            searchStatus.textContent = t("youtube_music.search_required");
            searchStatus.hidden = false;
            searchResults.replaceChildren();
            searchResults.hidden = true;
            return;
        }

        searchBtn.disabled = true;
        searchStatus.textContent = t("youtube_music.searching");
        searchStatus.hidden = false;
        searchResults.replaceChildren();
        searchResults.hidden = true;
        try {
            const response = await api.youtubeMusic.searchSongs(query);
            const results = response.results || [];
            renderSearchResults(results);
            searchStatus.textContent = t("youtube_music.search_results", { count: String(results.length) });
        } catch (e) {
            searchStatus.textContent = e.message;
        } finally {
            searchBtn.disabled = false;
        }
    });

    saveBtn.addEventListener("click", async () => {
        if (station.cur()) {
            const nextUrl = urlInput.value.trim();
            // Editing a saved-queue station into a playlist URL replaces its
            // frozen snapshot with the live playlist.
            if (station.cur().url !== nextUrl) station.cur().tracks = [];
            station.cur().url = nextUrl;
        }
        try {
            await station.save();
            toast(t("youtube_music.saved_stations"));
        } catch {
            // Error handling already deferred to the station manager
        }
    });

    function syncOAuthControls() {
        const clientId = ctx.getConfig?.()?.youtube_music?.oauth_client_id?.trim() || "";
        connectBtn.disabled = oauthStarting || oauthConnected || !clientId;
        discoverBtn.disabled = !oauthConnected;
        disconnectBtn.hidden = !oauthConnected;
        oauthStatus.textContent = oauthStarting
            ? t("youtube_music.sign_in_pending")
            : (oauthConnected ? t("youtube_music.connected") : t("youtube_music.not_connected"));
        oauthHint.textContent = clientId ? t("youtube_music.oauth_ready") : t("youtube_music.oauth_setup");
        selectedCount.textContent = selectedPlaylistIds.size
            ? t("youtube_music.selected_count", { count: String(selectedPlaylistIds.size) }) : "";
        importSelectedBtn.disabled = !oauthConnected || selectedPlaylistIds.size === 0;
    }

    async function refreshOAuthStatus() {
        try {
            const status = await api.youtubeMusic.oauthStatus();
            oauthConnected = !!status.connected;
        } catch {
            oauthConnected = false;
        }
        oauthChecked = true;
        syncOAuthControls();
    }

    function renderOwnedPlaylists(playlists) {
        discoveredPlaylists = playlists;
        selectedPlaylistIds.clear();
        playlistList.replaceChildren();
        playlistList.hidden = false;
        playlistStatus.hidden = false;
        playlistStatus.textContent = playlists.length
            ? t("youtube_music.playlists_found", { count: String(playlists.length) })
            : t("youtube_music.no_playlists");
        for (const playlist of playlists) {
            const checkbox = el("input", { type: "checkbox", value: playlist.id });
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) selectedPlaylistIds.add(playlist.id);
                else selectedPlaylistIds.delete(playlist.id);
                syncOAuthControls();
            });
            const details = el("span", { class: "youtube-playlist-details" }, [
                el("strong", {}, playlist.title || playlist.id),
                el("small", {}, t("youtube_music.playlist_item_count", { count: String(playlist.item_count ?? 0) })),
            ]);
            playlistList.append(el("label", { class: "youtube-playlist-item" }, [checkbox, details]));
        }
        syncOAuthControls();
    }

    connectBtn.addEventListener("click", async () => {
        oauthStarting = true;
        syncOAuthControls();
        try {
            await api.youtubeMusic.oauthStart();
            // OAuth opens in the system browser on the game PC. Poll until its
            // loopback callback stores the token, or leave the status message.
            for (let attempt = 0; attempt < 60; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                await refreshOAuthStatus();
                if (oauthConnected) break;
            }
        } catch (e) {
            toast(e.message, true);
        } finally {
            oauthStarting = false;
            syncOAuthControls();
        }
    });

    discoverBtn.addEventListener("click", async () => {
        discoverBtn.disabled = true;
        playlistStatus.hidden = false;
        playlistStatus.textContent = t("youtube_music.loading_playlists");
        try {
            const result = await api.youtubeMusic.ownedPlaylists();
            renderOwnedPlaylists(result.playlists || []);
        } catch (e) {
            playlistStatus.textContent = e.message;
            playlistList.hidden = true;
        } finally {
            syncOAuthControls();
        }
    });

    disconnectBtn.addEventListener("click", async () => {
        try {
            await api.youtubeMusic.oauthDisconnect();
            oauthConnected = false;
            discoveredPlaylists = [];
            selectedPlaylistIds.clear();
            playlistList.replaceChildren();
            playlistList.hidden = true;
            playlistStatus.hidden = true;
            syncOAuthControls();
        } catch (e) {
            toast(e.message, true);
        }
    });

    importSelectedBtn.addEventListener("click", async () => {
        if (!selectedPlaylistIds.size) return;
        importSelectedBtn.disabled = true;
        try {
            const result = await api.youtubeMusic.importOwnedPlaylists([...selectedPlaylistIds]);
            await station.load(true);
            toast(t("youtube_music.imported_playlists", { count: String(result.imported ?? 0) }));
            selectedPlaylistIds.clear();
            renderOwnedPlaylists(discoveredPlaylists);
            await ctx.onSaved?.();
        } catch (e) {
            toast(e.message, true);
        } finally {
            syncOAuthControls();
        }
    });

    castBtn.addEventListener("click", async () => {
        const url = urlInput.value.trim();
        if (!url) return;
        urlInput.disabled = true;
        castBtn.disabled = true;
        try {
            await api.youtubeMusic.cast(url);
            toast(t("toast.casting", { service: "YouTube Music" }));
            urlInput.value = "";
            await ctx.onSaved?.();
            station.loadQueue();
        } catch (e) {
            toast(e.message, true);
        } finally {
            urlInput.disabled = false;
            castBtn.disabled = false;
        }
    });

    shuffleBtn.addEventListener("click", async () => {
        const isShuffled = shuffleBtn.classList.contains("toggled");
        try {
            await api.youtubeMusic.shuffle(!isShuffled);
            toast(!isShuffled ? t("toast.shuffle_on") : t("toast.shuffle_off"));
            await ctx.onSaved?.();
            station.loadQueue();
        } catch (e) {
            toast(e.message, true);
        }
    });

    function render() {
        const state = ctx.getState();
        const isActive = state?.sources?.active === "youtube_music";
        card.hidden = !isActive;
        if (!isActive) return;
        station.load();
        if (!oauthChecked) refreshOAuthStatus();
        syncOAuthControls();
        const details = state?.sources?.available?.find(s => s.name === "youtube_music")?.details;
        station.sync(details);
    }

    return { render, invalidate: station.invalidate, els: { exportBtn, importBtn, importFileInput } };
}
