#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export function formatSha256Line(digest, fileName) {
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error("SHA-256 digest must be 64 lowercase hexadecimal characters");
  }
  if (
    typeof fileName !== "string"
    || fileName.length === 0
    || fileName.includes("/")
    || fileName.includes("\\")
    || /[\r\n]/u.test(fileName)
  ) {
    throw new Error("Checksum filename must be a single bounded basename");
  }
  return `${digest}  ${fileName}\n`;
}

export async function writeSha256File(filePath, outputPath) {
  const digest = await sha256File(filePath);
  const line = formatSha256Line(digest, path.basename(filePath));
  await writeFile(outputPath, line, { encoding: "utf8", flag: "w" });
  return digest;
}

export async function verifySha256File(filePath, checksumPath) {
  const raw = await readFile(checksumPath, "utf8");
  const line = raw.endsWith("\r\n")
    ? raw.slice(0, -2)
    : raw.endsWith("\n")
      ? raw.slice(0, -1)
      : raw;
  if (/[\r\n]/u.test(line)) throw new Error("Checksum file must contain exactly one line");
  const match = /^([0-9a-f]{64}) {2}([^/\\\r\n]+)$/u.exec(line);
  if (match === null) throw new Error("Checksum file format is invalid");
  const expectedName = path.basename(filePath);
  if (match[2] !== expectedName) {
    throw new Error(`Checksum filename ${match[2]} does not match ${expectedName}`);
  }
  const actual = await sha256File(filePath);
  if (match[1] !== actual) throw new Error("Checksum does not match release artifact");
  return actual;
}

function parseArguments(args) {
  let filePath;
  let outputPath;
  let verifyPath;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const assign = (name) => {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${name} requires a path`);
      index += 1;
      return path.resolve(value);
    };
    if (argument === "--file") filePath = assign("--file");
    else if (argument === "--output") outputPath = assign("--output");
    else if (argument === "--verify") verifyPath = assign("--verify");
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (filePath === undefined) throw new Error("--file is required");
  if ((outputPath === undefined) === (verifyPath === undefined)) {
    throw new Error("Specify exactly one of --output or --verify");
  }
  return { filePath, outputPath, verifyPath };
}

async function main() {
  const { filePath, outputPath, verifyPath } = parseArguments(process.argv.slice(2));
  if (outputPath !== undefined) {
    const digest = await writeSha256File(filePath, outputPath);
    process.stdout.write(`Wrote SHA-256 ${digest} for ${path.basename(filePath)}.\n`);
    return;
  }
  const digest = await verifySha256File(filePath, verifyPath);
  process.stdout.write(`Verified SHA-256 ${digest} for ${path.basename(filePath)}.\n`);
}

if (
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)
) {
  main().catch((error) => {
    process.stderr.write(
      `Release checksum operation failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
