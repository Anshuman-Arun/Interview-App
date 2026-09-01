#!/usr/bin/env node

import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".pnpm-store", "coverage", "dist"]);
const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;

const SENSITIVE_BASENAMES = new Set([
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  "service-account.json",
  "service_account.json",
  "application_default_credentials.json",
  ".netrc",
  ".git-credentials"
]);

const SENSITIVE_RELATIVE_PATHS = new Set([
  ".aws/credentials",
  ".kube/config",
  ".docker/config.json",
  ".config/gcloud/application_default_credentials.json"
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".log"
]);

const SENSITIVE_SUFFIXES = [
  ".sqlite-shm",
  ".sqlite-wal",
  ".sqlite3-shm",
  ".sqlite3-wal",
  ".db-shm",
  ".db-wal"
];

const SAFE_PUBLIC_EMAILS = new Set(["git@github.com"]);

function isAllowedPublicEmail(value) {
  const normalized = value.toLowerCase();
  return SAFE_PUBLIC_EMAILS.has(normalized) || normalized.endsWith("@users.noreply.github.com");
}

const CONTENT_RULES = [
  {
    code: "LOCAL_USER_PATH",
    pattern: /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'\x60<>]+|\/(?:Users|home)\/[^/\s"'\x60<>]+)/gu,
    message: "tracked content contains a user-specific absolute filesystem path"
  },
  {
    code: "EMAIL_ADDRESS",
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
    message: "tracked content contains an email address"
  },
  {
    code: "SECRET_PATTERN",
    pattern: /(?:AKIA[0-9A-Z]{16}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|\bsk-[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE[ ]KEY-----|-----BEGIN PGP PRIVATE[ ]KEY BLOCK-----)/gu,
    message: "tracked content matches a high-confidence credential/private-key signature"
  },
  {
    code: "URL_CREDENTIALS",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@[^\s"'\x60]+/giu,
    message: "tracked content contains credentials embedded in a URL"
  },
  {
    code: "PACKAGE_AUTH",
    pattern: /(?:^|\n)\s*(?:\/\/[^\s=]+:)?_authToken\s*=\s*(?!\$\{|\[REDACTED\]|<)[^\s#]+/gimu,
    message: "tracked package-manager configuration contains a literal authentication token"
  }
];

function parseRoot(args) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--root requires a path");
      root = path.resolve(value);
      index += 1;
    } else if (argument.startsWith("--root=")) {
      root = path.resolve(argument.slice("--root=".length));
    } else {
      throw new Error("Unknown argument: " + argument);
    }
  }
  return root;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function trackedFilesFromGit(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map(toPosix)
    .sort((left, right) => left.localeCompare(right));
}

async function fallbackFiles(root) {
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(toPosix(path.relative(root, fullPath)));
      }
    }
  }

  await walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function collectFiles(root) {
  return trackedFilesFromGit(root) ?? fallbackFiles(root);
}

function checkSensitivePath(relativePath, violations) {
  const normalized = toPosix(relativePath);
  const basename = path.posix.basename(normalized);
  const lowerBasename = basename.toLowerCase();
  const lowerNormalized = normalized.toLowerCase();

  if (SENSITIVE_RELATIVE_PATHS.has(lowerNormalized)) {
    violations.push({
      code: "SENSITIVE_FILE",
      file: normalized,
      message: "tracked cloud/container credential configuration is prohibited"
    });
  }

  if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
    violations.push({
      code: "SENSITIVE_FILE",
      file: normalized,
      message: "tracked environment files are prohibited; only .env.example may be committed"
    });
  }

  if (SENSITIVE_BASENAMES.has(lowerBasename)
      || SENSITIVE_EXTENSIONS.has(path.posix.extname(lowerBasename))
      || SENSITIVE_SUFFIXES.some((suffix) => lowerBasename.endsWith(suffix))) {
    violations.push({
      code: "SENSITIVE_FILE",
      file: normalized,
      message: "tracked credential, database, or log material is prohibited"
    });
  }
}

async function checkContent(root, relativePath, violations) {
  const absolutePath = path.join(root, relativePath);
  const metadata = await lstat(absolutePath);

  if (metadata.isSymbolicLink()) {
    violations.push({
      code: "UNSCANNED_FILE",
      file: toPosix(relativePath),
      message: "tracked symbolic links require explicit manual review and are prohibited by the automatic public-release gate"
    });
    return;
  }

  if (!metadata.isFile()) {
    violations.push({
      code: "UNSCANNED_FILE",
      file: toPosix(relativePath),
      message: "tracked non-regular filesystem entries are prohibited by the public-release gate"
    });
    return;
  }

  const bytes = await readFile(absolutePath);
  if (bytes.length > MAX_TEXT_FILE_BYTES) {
    violations.push({
      code: "UNSCANNED_FILE",
      file: toPosix(relativePath),
      message: "tracked files larger than 4 MiB require explicit manual review"
    });
    return;
  }
  if (bytes.includes(0)) {
    violations.push({
      code: "UNSCANNED_FILE",
      file: toPosix(relativePath),
      message: "tracked binary files require explicit manual review"
    });
    return;
  }
  const content = bytes.toString("utf8");

  for (const rule of CONTENT_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    const matches = content.match(pattern) ?? [];
    if (rule.code === "EMAIL_ADDRESS" && matches.length > 0
        && matches.every((value) => isAllowedPublicEmail(value))) {
      continue;
    }
    if (matches.length > 0) {
      violations.push({
        code: rule.code,
        file: toPosix(relativePath),
        message: rule.message
      });
    }
  }
}

function uniqueSortedViolations(violations) {
  const unique = new Map();
  for (const violation of violations) {
    const key = violation.code + "\0" + violation.file + "\0" + violation.message;
    unique.set(key, violation);
  }
  return [...unique.values()].sort((left, right) =>
    left.file.localeCompare(right.file)
      || left.code.localeCompare(right.code)
      || left.message.localeCompare(right.message)
  );
}

async function main() {
  const root = parseRoot(process.argv.slice(2));
  const violations = [];
  const files = await collectFiles(root);

  for (const relativePath of files) {
    checkSensitivePath(relativePath, violations);
    await checkContent(root, relativePath, violations);
  }

  const finalViolations = uniqueSortedViolations(violations);
  if (finalViolations.length > 0) {
    process.stderr.write(
      "Public-release hygiene check failed with "
        + String(finalViolations.length)
        + " violation(s):\n"
        + finalViolations.map((item) => "- [" + item.code + "] " + item.file + ": " + item.message).join("\n")
        + "\n"
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    "Public-release hygiene checks passed ("
      + String(files.length)
      + " tracked file(s) scanned).\n"
  );
}

await main();
