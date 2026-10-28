import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach } from "vitest";
import { initI18n } from "../dist/js/i18n.js";

const english = readFileSync(resolve("ui/dist/lang/en.json"), "utf8");

beforeEach(async () => {
  localStorage.removeItem("fh6-language");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => english });
  try {
    await initI18n();
  } finally {
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete globalThis.fetch;
  }
});
