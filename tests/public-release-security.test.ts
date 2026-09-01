import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const checkerPath = fileURLToPath(new URL("../scripts/check-public-release.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(files: Readonly<Record<string, string | Uint8Array>>): string {
  const root = mkdtempSync(join(tmpdir(), "interview-public-release-"));
  fixtureRoots.push(root);

  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }

  return root;
}

function runChecker(root: string) {
  const result = spawnSync(process.execPath, [checkerPath, "--root", root], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function output(result: ReturnType<typeof runChecker>): string {
  return result.stdout + "\n" + result.stderr;
}

describe("public-release hygiene checker", () => {
  it("accepts the current tracked repository", () => {
    const result = runChecker(repositoryRoot);
    expect(output(result)).toContain("Public-release hygiene checks passed");
    expect(result.status).toBe(0);
  });

  it("allows non-personal GitHub transport and noreply addresses", () => {
    const root = createFixture({
      "README.md": "git@github.com\n12345+example@users.noreply.github.com\n"
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
  });

  it("allows the documented environment example file", () => {
    const root = createFixture({
      ".env.example": "EXAMPLE=value\n"
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
  });

  it("allows package-manager credentials supplied by safe placeholders", () => {
    const root = createFixture({
      ".npmrc": [
        "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
        "_auth=${NPM_AUTH}",
        "_password=[REDACTED]"
      ].join("\n") + "\n"
    });
    const result = runChecker(root);
    expect(result.status).toBe(0);
  });

  const prohibitedCases: readonly {
    readonly name: string;
    readonly expectedCode: string;
    readonly files: Readonly<Record<string, string | Uint8Array>>;
  }[] = [
    {
      name: "tracked environment file",
      expectedCode: "SENSITIVE_FILE",
      files: { ".env": "EXAMPLE=value\n" }
    },
    {
      name: "mixed-case tracked environment file",
      expectedCode: "SENSITIVE_FILE",
      files: { ".Env.production": "EXAMPLE=value\n" }
    },
    {
      name: "environment file with .env extension",
      expectedCode: "SENSITIVE_FILE",
      files: { "production.env": "EXAMPLE=value\n" }
    },
    {
      name: "direnv environment file",
      expectedCode: "SENSITIVE_FILE",
      files: { ".envrc": "export EXAMPLE=value\n" }
    },
    {
      name: "local Windows user path",
      expectedCode: "LOCAL_USER_PATH",
      files: { "README.md": "path=" + "C:" + "\\Users\\alice\\private\\file.txt\n" }
    },
    {
      name: "local POSIX user path",
      expectedCode: "LOCAL_USER_PATH",
      files: { "README.md": "path=" + "/home" + "/alice/private/file.txt\n" }
    },
    {
      name: "email address",
      expectedCode: "EMAIL_ADDRESS",
      files: { "README.md": "contact=" + "person" + "@" + "example.com\n" }
    },
    {
      name: "GitHub token signature",
      expectedCode: "SECRET_PATTERN",
      files: { "config.txt": "token=" + "ghp_" + "A".repeat(36) + "\n" }
    },
    {
      name: "private key header",
      expectedCode: "SECRET_PATTERN",
      files: { "config.txt": "-----BEGIN " + "PRIVATE KEY-----\nplaceholder\n" }
    },
    {
      name: "credential-bearing URL",
      expectedCode: "URL_CREDENTIALS",
      files: { "config.txt": "https://" + "user" + ":" + "pass" + "@example.invalid/path\n" }
    },
    {
      name: "literal package-manager auth token",
      expectedCode: "PACKAGE_AUTH",
      files: { ".npmrc": "_auth" + "Token=" + "A".repeat(24) + "\n" }
    },
    {
      name: "legacy package-manager auth credential",
      expectedCode: "PACKAGE_AUTH",
      files: { ".npmrc": "_auth=" + "A".repeat(24) + "\n" }
    },
    {
      name: "legacy package-manager password credential",
      expectedCode: "PACKAGE_AUTH",
      files: { ".npmrc": "_password=" + "A".repeat(24) + "\n" }
    },
    {
      name: "binary tracked file",
      expectedCode: "UNSCANNED_FILE",
      files: { "asset.bin": new Uint8Array([0, 1, 2, 3]) }
    },
    {
      name: "oversized tracked file",
      expectedCode: "UNSCANNED_FILE",
      files: { "large.txt": "x".repeat(4 * 1024 * 1024 + 1) }
    }
  ];

  for (const prohibitedCase of prohibitedCases) {
    it("fails closed on " + prohibitedCase.name, () => {
      const root = createFixture(prohibitedCase.files);
      const result = runChecker(root);
      expect(result.status).not.toBe(0);
      expect(output(result)).toContain("[" + prohibitedCase.expectedCode + "]");
    });
  }
});
