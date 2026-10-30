import { api } from "../data/api.js";
import { el } from "../lib/dom.js";
import { changed } from "../lib/store.js";
import { t } from "../i18n.js";

export function depRow(tool) {
  let label = t("deps.ready");
  let cls = "";
  if (tool.downloading) {
    const pct = tool.total_bytes ? Math.round((tool.downloaded_bytes / tool.total_bytes) * 100) : null;
    label = pct === null
      ? t("deps.downloading_mb", { mb: (tool.downloaded_bytes / 1e6).toFixed(1) })
      : t("deps.downloading_pct", { pct });
  } else if (tool.error) {
    label = tool.error;
    cls = "err";
  }
  const fill = el("div", { class: "dep-fill" });
  fill.style.transform = `scaleX(${tool.downloading && tool.total_bytes ? tool.downloaded_bytes / tool.total_bytes : 0})`;
  return el("div", { class: "dep-row" }, [
    el("span", { class: "dep-name" }, tool.name),
    el("span", { class: "dep-state " + cls }, label),
    el("div", { class: "dep-bar" }, [fill]),
  ]);
}

export function createDeps(main) {
  let tools = [];
  const list = el("div", {});
  const card = el("section", { class: "card", id: "deps-card", hidden: true }, [
    el("h2", { dataset: { i18n: "deps.title" } }, t("deps.title")),
    el("p", {
      class: "muted",
      dataset: { i18nHtml: "deps.description" },
      html: t("deps.description"),
    }),
    list,
  ]);
  main.append(card);

  function render() {
    card.hidden = !tools.some(toolItem => toolItem.downloading || toolItem.error);
    if (card.hidden) return;
    const sig = tools.map(toolItem => `${toolItem.name}:${toolItem.downloading}:${toolItem.downloaded_bytes}:${toolItem.error}`).join("|");
    if (changed("deps", sig)) list.replaceChildren(...tools.map(depRow));
  }

  async function poll() {
    // Downloads are the only thing that changes here, and they only ever run
    // while the card is visible; skip the request entirely otherwise.
    if (document.hidden) {
      setTimeout(poll, 15000);
      return;
    }
    try {
      const r = await api.getDeps();
      tools = Array.isArray(r.tools) ? r.tools : [];
      render();
    } catch {
      // keep last
    }
    const downloading = tools.some(toolItem => toolItem.downloading);
    // Idle tools never change, so back off hard instead of polling forever.
    setTimeout(poll, downloading ? 1000 : 30000);
  }

  return { start: poll };
}
