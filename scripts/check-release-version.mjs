#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function validateReleaseVersion(tag, version) {
  if (typeof tag !== "string" || !STABLE_TAG.test(tag)) {
    throw new Error("Release tag must be stable semantic version syntax: vMAJOR.MINOR.PATCH");
  }
  if (typeof version !== "string" || !STABLE_VERSION.test(version)) {
    throw new Error("Canonical package version must be stable semantic version syntax: MAJOR.MINOR.PATCH");
  }
  const tagVersion = tag.slice(1);
  if (tagVersion !== version) {
    throw new Error(`Release tag ${tag} does not match canonical package version ${version}`);
  }
  return Object.freeze({
    tag,
    version,
    channel: "stable"
  });
}

function parseArguments(args) {
  let tag = process.env["GITHUB_REF_NAME"];
  let packagePath = path.join(ROOT, "package.json");

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--tag") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--tag requires a value");
      tag = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--tag=")) {
      tag = argument.slice("--tag=".length);
      continue;
    }
    if (argument === "--package") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--package requires a path");
      packagePath = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--package=")) {
      packagePath = path.resolve(argument.slice("--package=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (tag === undefined || tag.length === 0) {
    throw new Error("Release tag is required via --tag or GITHUB_REF_NAME");
  }
  return { tag, packagePath };
}

async function main() {
  const { tag, packagePath } = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const result = validateReleaseVersion(tag, packageJson.version);
  process.stdout.write(
    `Release version validated: ${result.tag} = ${result.version} (${result.channel}).\n`
  );
}

if (
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)
) {
  main().catch((error) => {
    process.stderr.write(
      `Release version validation failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
