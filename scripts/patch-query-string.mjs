import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const expoRouterEntry = require.resolve("expo-router");
const expoRouterRequire = createRequire(expoRouterEntry);
const queryStringEntry = expoRouterRequire.resolve("query-string");
const queryStringPackagePath = join(dirname(queryStringEntry), "package.json");
const queryStringPackage = JSON.parse(
  await readFile(queryStringPackagePath, "utf8"),
);

if (queryStringPackage.version !== "7.1.3") {
  throw new Error(
    `Unsupported query-string version: ${queryStringPackage.version}`,
  );
}

const original = "const decodeComponent = require('decode-uri-component');";
const patched = [
  "const decodeComponentModule = require('decode-uri-component');",
  "const decodeComponent = decodeComponentModule.default ?? decodeComponentModule;",
].join("\n");
const source = await readFile(queryStringEntry, "utf8");

if (!source.includes(patched)) {
  if (!source.includes(original)) {
    throw new Error("query-string decoder import no longer matches the patch");
  }

  await writeFile(queryStringEntry, source.replace(original, patched));
}
