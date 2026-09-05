#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(ROOT, "apps", "desktop", "assets", "icon.png.b64");
const target = path.join(ROOT, "apps", "desktop", "assets", "icon.png");
const EXPECTED_SHA256 = "b999e0aa0a5d1cfc31058d57098a10de871432182291cb0c548cf0fa0fb8c68f";

const encoded = (await readFile(source, "utf8")).trim();
const bytes = Buffer.from(encoded, "base64");
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== EXPECTED_SHA256) {
  process.stderr.write("Desktop icon source failed its reviewed SHA-256 check.\n");
  process.exitCode = 1;
} else {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
