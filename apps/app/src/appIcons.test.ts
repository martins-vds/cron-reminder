import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { lightColors } from "./theme";

const asset = (path: string) => new URL(`../${path}`, import.meta.url);
async function readPng(path: string) {
  const { data, info } = await sharp(fileURLToPath(asset(path)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { ...info, data };
}
const background = lightColors.accent
  .slice(1)
  .match(/../g)!
  .map((component) => Number.parseInt(component, 16));

describe("installed app icons", () => {
  it("uses an opaque brand-colored Android background layer", async () => {
    const { width, height, data } = await readPng(
      "assets/android-icon-background.png",
    );
    expect([width, height]).toEqual([1024, 1024]);
    let mismatchedPixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (
        data[offset + 3] !== 255 ||
        background.some((value, channel) => data[offset + channel] !== value)
      )
        mismatchedPixels++;
    }
    expect(mismatchedPixels).toBe(0);
  });

  it.each([
    ["assets/icon.png", 1024, true],
    ["assets/favicon.png", 512, true],
    ["public/icon-192.png", 192, true],
    ["public/icon-512.png", 512, true],
    ["public/apple-touch-icon.png", 180, true],
    ["assets/android-icon-foreground.png", 1024, false],
    ["assets/android-icon-monochrome.png", 1024, false],
  ] as const)(
    "exports %s at its intended resolution",
    async (path, size, opaque) => {
      const file = await readFile(asset(path));
      const image = await readPng(path);
      expect([image.width, image.height]).toEqual([size, size]);
      expect(image.data.length).toBe(size * size * 4);
      if (opaque) {
        expect(file[25]).toBe(2);
        expect([...image.data.subarray(0, 4)]).toEqual([...background, 255]);
      } else {
        expect(image.data[3]).toBe(0);
      }
      const license = await readFile(asset("public/icon-LICENSE.txt"));
      expect(file.includes(license)).toBe(true);
    },
  );

  it.each([
    ["public/icon-512.png", 0.4, true],
    ["assets/android-icon-foreground.png", 33 / 108, false],
    ["assets/android-icon-monochrome.png", 33 / 108, false],
  ] as const)(
    "keeps the clock inside the safe mask for %s",
    async (path, safeRadius, opaque) => {
      const { width, data } = await readPng(path);
      let farthest = 0;
      for (let pixel = 0; pixel < data.length / 4; pixel++) {
        const offset = pixel * 4;
        const glyph = opaque
          ? background.some(
              (value, channel) => data[offset + channel] !== value,
            )
          : data[offset + 3] > 0;
        if (!glyph) continue;
        const x = (pixel % width) + 0.5 - width / 2;
        const y = Math.floor(pixel / width) + 0.5 - width / 2;
        farthest = Math.max(farthest, Math.hypot(x, y));
      }
      expect(farthest).toBeGreaterThan(width / 4);
      expect(farthest).toBeLessThanOrEqual(width * safeRadius);
    },
  );
});
