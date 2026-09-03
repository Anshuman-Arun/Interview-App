#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = path.resolve(ROOT, "dist/windows/win-unpacked");
const RESOURCES = path.join(PACKAGE_ROOT, "resources");

const exactCopies = [
  ["preload.cjs", "apps/desktop/preload.cjs"],
  ["workers/python/local_model_worker.py", "workers/python/local_model_worker.py"],
  [
    "workers/python/requirements-local-model-runtime.txt",
    "workers/python/requirements-local-model-runtime.txt"
  ]
];

function fail(message) {
  process.stderr.write(`Packaged desktop verification failed: ${message}\n`);
  process.exitCode = 1;
}

async function requireRegularFile(target, label) {
  const metadata = await lstat(target).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is missing or is not a regular file`);
  }
}

async function sha256(target) {
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function walk(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const next = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link packaged outside ASAR: ${next}`);
    if (entry.isDirectory()) {
      output.push(...await walk(path.join(directory, entry.name), next));
    } else if (entry.isFile()) {
      output.push(next.split(path.sep).join("/"));
    }
  }
  return output;
}

async function inspectAsar() {
  const asarPath = path.join(RESOURCES, "app.asar");
  await requireRegularFile(asarPath, "app.asar");
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    command,
    ["dlx", "@electron/asar@4.3.0", "list", asarPath],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    }
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ASAR listing failed: ${result.stderr.trim()}`);
  }

  const entries = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.replaceAll("\\", "/").replace(/^\/+/, ""))
    .filter(Boolean);
  const requiredMain = "dist/desktop-runtime/apps/desktop/src/main.js";
  if (!entries.includes(requiredMain)) {
    throw new Error("compiled Electron main entry is absent from app.asar");
  }

  const prohibited = entries.filter((entry) =>
    entry === "tests"
    || entry.startsWith("tests/")
    || entry === "workers"
    || entry.startsWith("workers/")
    || entry.endsWith(".sqlite")
    || entry.endsWith(".sqlite3")
    || entry.endsWith(".db")
    || entry.endsWith(".log")
    || /(^|\/)\.env(?:\.|$)/iu.test(entry)
    || (
      entry.startsWith("dist/desktop-runtime/")
      && (entry.endsWith(".ts") || entry.endsWith(".map"))
    )
  );
  if (prohibited.length > 0) {
    throw new Error(`prohibited app.asar entries: ${prohibited.slice(0, 20).join(", ")}`);
  }
}

async function main() {
  await requireRegularFile(path.join(PACKAGE_ROOT, "Interview App.exe"), "packaged executable");
  await requireRegularFile(path.join(RESOURCES, "web", "index.html"), "renderer index");
  await requireRegularFile(path.join(RESOURCES, "app.asar"), "app.asar");

  for (const [packaged, source] of exactCopies) {
    const packagedPath = path.join(RESOURCES, ...packaged.split("/"));
    const sourcePath = path.join(ROOT, ...source.split("/"));
    await requireRegularFile(packagedPath, packaged);
    if (await sha256(packagedPath) !== await sha256(sourcePath)) {
      throw new Error(`${packaged} does not match its reviewed source`);
    }
  }

  const workerFiles = (await walk(path.join(RESOURCES, "workers", "python"))).sort();
  const allowedWorkerFiles = [
    "local_model_worker.py",
    "requirements-local-model-runtime.txt"
  ];
  if (JSON.stringify(workerFiles) !== JSON.stringify(allowedWorkerFiles)) {
    throw new Error(`unexpected Python worker resources: ${workerFiles.join(", ")}`);
  }

  const resourceFiles = await walk(RESOURCES);
  const prohibitedExternal = resourceFiles.filter((entry) =>
    /(^|\/)(?:tests?|fixtures?)(\/|$)/iu.test(entry)
    || /(^|\/)test_fixture_worker\.py$/iu.test(entry)
    || /(^|\/)\.env(?:\.|$)/iu.test(entry)
    || /\.(?:sqlite3?|db|log)$/iu.test(entry)
  );
  if (prohibitedExternal.length > 0) {
    throw new Error(
      `prohibited external resources: ${prohibitedExternal.slice(0, 20).join(", ")}`
    );
  }

  const webAssets = resourceFiles.filter((entry) => entry.startsWith("web/assets/"));
  if (webAssets.length === 0) throw new Error("renderer asset bundle is empty");

  await inspectAsar();
  process.stdout.write(
    `Packaged desktop verification passed (${String(resourceFiles.length)} external resource files inspected).\n`
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
