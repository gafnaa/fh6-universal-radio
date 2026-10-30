import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

describe("performance budget", () => {
  it("ships JS + CSS under 280 KB (fonts excluded)", () => {
    const total = walk(distDir)
      .filter(f => /\.(js|css)$/.test(f))
      .reduce((sum, f) => sum + statSync(f).size, 0);
    expect(total).toBeLessThan(280 * 1024);
  });

  it("keeps the entry HTML under 8 KB", () => {
    expect(statSync(join(distDir, "index.html")).size).toBeLessThan(8 * 1024);
  });

  it("ships no stylesheet that nothing imports", () => {
    const css = walk(distDir).filter(f => f.endsWith(".css"));
    const reachable = new Set();
    const queue = [join(distDir, "css", "styles.css")];
    while (queue.length) {
      const file = queue.pop();
      if (reachable.has(file)) continue;
      reachable.add(file);
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/@import\s+url\(["']?([^"')]+)["']?\)/g)) {
        queue.push(join(dirname(file), match[1]));
      }
    }
    const orphans = css.filter(f => !reachable.has(f)).map(f => f.slice(distDir.length + 1));
    expect(orphans).toEqual([]);
  });

  it("ships no web font that no stylesheet declares", () => {
    const declared = new Set();
    for (const file of walk(distDir).filter(f => f.endsWith(".css"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/url\(["']?([^"')]+\.woff2?)["']?\)/g)) {
        declared.add(match[1].split("/").pop());
      }
    }
    const shipped = readdirSync(join(distDir, "fonts"));
    const unused = shipped.filter(name => !declared.has(name));
    expect(unused).toEqual([]);
  });
});
