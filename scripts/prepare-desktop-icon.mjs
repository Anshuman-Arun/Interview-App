#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(ROOT, "apps", "desktop", "assets", "icon.png.b64");
const target = path.join(ROOT, "apps", "desktop", "assets", "icon.png");
const EXPECTED_SHA256 = "98a6b211d3d4380b146268fe7e7b2fe913ff4ef39f693094b911d6e961194a16";

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
