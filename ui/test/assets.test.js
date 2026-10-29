import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const asset = name => readFileSync(join(process.cwd(), "ui/dist/assets", name));
const pngDimensions = image => ({ width: image.readUInt32BE(16), height: image.readUInt32BE(20) });

describe("dashboard artwork assets", () => {
  it("ships resolution-appropriate default artwork instead of duplicate full-size images", () => {
    const hero = asset("default_artwork_512.png");
    const mini = asset("default_artwork_128.png");

    expect(pngDimensions(hero)).toEqual({ width: 512, height: 512 });
    expect(pngDimensions(mini)).toEqual({ width: 128, height: 128 });
    expect(hero.byteLength).toBeLessThan(100_000);
    expect(mini.byteLength).toBeLessThan(16_000);
  });

  it("uses the small lazy-loaded image for the mini player", () => {
    const html = readFileSync(join(process.cwd(), "ui/dist/index.html"), "utf8");
    const nowPlaying = readFileSync(join(process.cwd(), "ui/dist/js/render/nowPlaying.js"), "utf8");

    expect(html).toContain('src="assets/default_artwork_512.png"');
    expect(html).toContain('src="assets/default_artwork_128.png" alt="" loading="lazy"');
    expect(nowPlaying).toContain('"assets/default_artwork_512.png"');
    expect(nowPlaying).toContain('"assets/default_artwork_128.png"');
  });
});
