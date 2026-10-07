import { Buffer } from "node:buffer";
import console from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { lightColors } from "../apps/app/src/theme.ts";

const asset = (path) => new URL(`../apps/app/${path}`, import.meta.url);
const clock = await readFile(asset("assets/clock.svg"), "utf8");
const license = await readFile(asset("public/icon-LICENSE.txt"), "utf8");
const canvasSize = 1024;

function artwork(glyphSize, background) {
  const inset = (canvasSize - glyphSize) / 2;
  const glyph = clock
    .replace("<svg", `<svg x="${inset}" y="${inset}"`)
    .replace('width="24"', `width="${glyphSize}"`)
    .replace('height="24"', `height="${glyphSize}"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasSize}" height="${canvasSize}" viewBox="0 0 ${canvasSize} ${canvasSize}" color="${lightColors.onAccent}">
  <metadata>${license}</metadata>
  ${background ? `<rect width="${canvasSize}" height="${canvasSize}" fill="${lightColors.accent}" />` : ""}
  ${glyph}
</svg>
`;
}

function withLicense(png) {
  const contents = Buffer.from(`License\0${license}`, "latin1");
  const chunk = Buffer.alloc(contents.length + 12);
  chunk.writeUInt32BE(contents.length);
  chunk.write("tEXt", 4, "ascii");
  contents.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  // IHDR must stay first; license metadata follows it.
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

await writeFile(asset("assets/icon.svg"), artwork(768, true));
await writeFile(
  asset("assets/android-icon-foreground.svg"),
  artwork(640, false),
);

for (const [path, size, foreground] of [
  ["assets/icon.png", 1024, false],
  ["assets/favicon.png", 512, false],
  ["public/icon-192.png", 192, false],
  ["public/icon-512.png", 512, false],
  ["public/apple-touch-icon.png", 180, false],
  ["assets/android-icon-foreground.png", 1024, true],
  ["assets/android-icon-monochrome.png", 1024, true],
]) {
  const image = sharp(
    fileURLToPath(
      asset(
        foreground ? "assets/android-icon-foreground.svg" : "assets/icon.svg",
      ),
    ),
  ).resize(size, size);
  if (!foreground) image.removeAlpha();
  await writeFile(asset(path), withLicense(await image.png().toBuffer()));
}
const background = await sharp({
  create: {
    width: canvasSize,
    height: canvasSize,
    channels: 3,
    background: lightColors.accent,
  },
})
  .png()
  .toBuffer();
await writeFile(asset("assets/android-icon-background.png"), background);
console.log(
  "Generated app icons from the clock vector and existing brand tokens.",
);
