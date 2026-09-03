#!/usr/bin/env node

import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const relative of ["dist/desktop-runtime", "dist/windows"]) {
  await rm(path.join(root, ...relative.split("/")), {
    recursive: true,
    force: true
  });
}
