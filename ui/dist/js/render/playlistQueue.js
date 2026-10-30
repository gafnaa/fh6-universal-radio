import { el, highlightText } from "../lib/dom.js";
import { icons } from "../icons.js";
import { t } from "../i18n.js";
import { translateLoadingPlaceholder } from "../lib/format.js";

// Playlists can hold thousands of entries. Building a <li> (with cover <img>)
// for every one of them makes the first paint and every re-render expensive,
// so rows are rendered in chunks: enough to fill the visible list plus a
// scroll's worth of look-ahead, with a "show more" row extending the window.
const CHUNK = 150;

// Per-list render state, so re-rendering (every state tick) keeps the user's
// expanded window instead of collapsing back to the first chunk.
const listState = new WeakMap();

function stateFor(trackList) {
    let s = listState.get(trackList);
    if (!s) {
        s = { limit: CHUNK, key: "" };
        listState.set(trackList, s);
    }
    return s;
}

/**
 * Renders a shared track-queue UI used by Local Files, YouTube Music, and Jellyfin.
 * Each source has slightly different track shapes, so the caller provides small
 * accessor functions instead of this module assuming a fixed track structure.
 *
 * @param {HTMLUListElement} trackList - the <ul> to render into
 * @param {object} queue - { cursor, tracks }
 * @param {string} search - current search/filter text
 * @param {object} opts
 * @param {(track: object) => string} opts.getTitle - main line text
 * @param {(track: object) => string|null} opts.getSubtitle - secondary line text (artist/folder/url), or null to omit
 * @param {(track: object) => string} opts.getCoverUrl - cover image URL, or "" for none
 * @param {(track: object) => string[]} opts.getSearchFields - strings to match against the search filter
 * @param {(track: object, index: number) => void} opts.onTrackClick - called when a row is clicked
 * @param {(track: object, to: number) => void} [opts.onMoveTrack] - move an upcoming row to a new index
 * @param {(track: object) => void} [opts.onRemoveTrack] - remove an upcoming row
 */
export function renderTrackQueue(trackList, queue, search, opts) {
    const fold = s => (s || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    const terms = fold(search).split(/\s+/).filter(Boolean);
    // Highlighting matches the raw (non-folded) query against the raw text,
    // so it can't reuse `terms` above — see highlightText()'s doc comment.
    const rawTerms = (search || "").split(/\s+/).filter(Boolean);

    const rows = (queue.tracks || []).filter(track => {
        if (!terms.length) return true;
        const hay = fold(opts.getSearchFields(track).join(" "));
        return terms.every(w => hay.includes(w));
    });

    const state = stateFor(trackList);
    // A new filter starts a fresh window; removing a track should not collapse
    // a window the user has already expanded.
    const windowKey = terms.join(" ");
    if (windowKey !== state.key) {
        state.key = windowKey;
        state.limit = CHUNK;
    }
    if (state.limit > rows.length) state.limit = Math.max(CHUNK, rows.length);
    // Always keep the current track inside the window, or the list would open
    // on the wrong end of a long playlist.
    const cursorRow = rows.findIndex(track => track.index === queue.cursor);
    if (cursorRow >= state.limit) state.limit = Math.min(rows.length, cursorRow + CHUNK);

    const visible = rows.slice(0, state.limit);
    const hidden = rows.length - visible.length;

    const statusRow = queue.scanning
        ? el("li", { class: "queue-status muted" }, [el("span", { class: "spinner" }), t("label.queue_scanning")])
        : queue.error
            ? el("li", { class: "queue-status error" }, queue.error)
            : null;

    const trackRows = visible.map(track => {
        const coverUrl = opts.getCoverUrl(track) || "";

        const coverImg = el("img", {
            class: "track-cover-img",
            src: coverUrl,
            alt: "",
            loading: "lazy",
            "aria-hidden": "true",
        });

        const isCurrent = track.index === queue.cursor;
        const coverWrap = el("div", { class: "track-cover" }, [coverImg]);
        if (!coverUrl) {
            coverWrap.dataset.noart = "1";
            coverWrap.append(
                el("div", { class: "eq" }, [
                    el("span", { class: "eq-bar" }),
                    el("span", { class: "eq-bar" }),
                    el("span", { class: "eq-bar" }),
                ])
            );
        }

        const title = translateLoadingPlaceholder(opts.getTitle(track), t) || t("label.unknown_title");
        const subtitle = translateLoadingPlaceholder(opts.getSubtitle(track), t);

        const infoWrap = el("div", { class: "track-info" }, [
            el("span", { class: "track-title" }, highlightText(title, rawTerms)),
            subtitle ? el("span", { class: "track-folder muted" }, highlightText(subtitle, rawTerms)) : null,
        ]);

        // Only upcoming rows are editable, and only when the source exposes
        // queue editing; the current track always stays in place.
        const canEdit = !isCurrent && track.index > queue.cursor;
        let actions = null;
        if (canEdit && (opts.onMoveTrack || opts.onRemoveTrack)) {
            const buttons = [];
            if (opts.onMoveTrack) {
                const up = el("button", {
                    type: "button", class: "icon-btn track-action",
                    "aria-label": t("queue.move_up"), title: t("queue.move_up"), html: icons.up,
                    disabled: track.index <= queue.cursor + 1,
                });
                up.addEventListener("click", event => {
                    event.stopPropagation();
                    opts.onMoveTrack(track, track.index - 1);
                });
                const down = el("button", {
                    type: "button", class: "icon-btn track-action",
                    "aria-label": t("queue.move_down"), title: t("queue.move_down"), html: icons.down,
                    disabled: track.index >= (queue.tracks?.length ?? 0) - 1,
                });
                down.addEventListener("click", event => {
                    event.stopPropagation();
                    opts.onMoveTrack(track, track.index + 1);
                });
                buttons.push(up, down);
            }
            if (opts.onRemoveTrack) {
                const remove = el("button", {
                    type: "button", class: "icon-btn track-action danger",
                    "aria-label": t("queue.remove"), title: t("queue.remove"), html: icons.trash,
                });
                remove.addEventListener("click", event => {
                    event.stopPropagation();
                    opts.onRemoveTrack(track);
                });
                buttons.push(remove);
            }
            actions = el("div", { class: "track-actions" }, buttons);
        }

        const li = el("li", {
            class: "track" + (isCurrent ? " current" : ""),
        }, [coverWrap, infoWrap, actions]);

        li.addEventListener("click", () => opts.onTrackClick(track, track.index));

        // Drag an upcoming row onto another to reorder. The current track and
        // already-played rows are not draggable, matching the button rules.
        if (canEdit && opts.onMoveTrack) {
            li.draggable = true;
            li.dataset.queueIndex = String(track.index);
            li.addEventListener("dragstart", event => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(track.index));
                li.classList.add("dragging");
            });
            li.addEventListener("dragend", () => li.classList.remove("dragging"));
            li.addEventListener("dragover", event => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                li.classList.add("drop-target");
            });
            li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
            li.addEventListener("drop", event => {
                event.preventDefault();
                event.stopPropagation();
                li.classList.remove("drop-target");
                const from = Number(event.dataTransfer.getData("text/plain"));
                if (!Number.isInteger(from) || from === track.index) return;
                opts.onMoveTrack({ index: from }, track.index);
            });
        }

        return li;
    });

    trackList.replaceChildren(...(statusRow ? [statusRow] : []), ...trackRows);

    if (hidden > 0) {
        const more = el("li", { class: "queue-more" }, [
            el("button", { type: "button", class: "btn ghost" },
                t("label.queue_show_more", { count: String(Math.min(hidden, CHUNK)) })),
        ]);
        more.querySelector("button").addEventListener("click", () => {
            state.limit += CHUNK;
            renderTrackQueue(trackList, queue, search, opts);
        });
        trackList.append(more);
    }

    if (!rows.length && !queue.scanning && !queue.error) {
        trackList.append(
            el("li", { class: "muted" }, terms.length ? t("label.no_matches") : t("label.queue_empty")),
        );
    }

    const current = trackList.querySelector(".track.current");
    if (current) {
        trackList.scrollTo({
            top: current.offsetTop - trackList.offsetTop - trackList.clientHeight / 2 + current.clientHeight / 2,
            behavior: "smooth",
        });
    }
}