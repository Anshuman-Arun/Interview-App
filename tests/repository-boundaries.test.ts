import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const checkerPath = fileURLToPath(new URL("../scripts/check-architecture-boundaries.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "interview-boundary-"));
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

function checkerOutput(result: ReturnType<typeof runChecker>): string {
  return result.stdout + "\n" + result.stderr;
}

describe("repository architecture boundary checker", () => {
  it("accepts the current repository", () => {
    const result = runChecker(repositoryRoot);
    expect(checkerOutput(result)).toContain("Architecture boundary checks passed");
    expect(result.status).toBe(0);
  });

  const prohibitedCases: readonly {
    readonly name: string;
    readonly expectedCode: string;
    readonly files: Readonly<Record<string, string>>;
  }[] = [
    {
      name: "authoritative event append outside SessionWriter",
      expectedCode: "AUTHORITY_APPEND",
      files: {
        "apps/server/src/rogue.ts": "const store = { appendIdempotent: (_value: unknown) => undefined }; store.appendIdempotent({});\n"
      }
    },
    {
      name: "domain importing another project package",
      expectedCode: "DEPENDENCY_DIRECTION",
      files: {
        "packages/domain/src/bad.ts": "import \"../../events/src/index.js\";\n"
      }
    },
    {
      name: "events importing a project package other than domain",
      expectedCode: "DEPENDENCY_DIRECTION",
      files: {
        "packages/events/src/bad.ts": "import \"../../persistence/src/index.js\";\n"
      }
    },
    {
      name: "a lower-level package importing apps/server",
      expectedCode: "LOWER_LEVEL_APP_IMPORT",
      files: {
        "packages/problems/src/bad.ts": "import \"../../../apps/server/src/loopback-command-server.js\";\n"
      }
    },
    {
      name: "provider code gaining process-backed tool execution",
      expectedCode: "PROVIDER_TOOL_CAPABILITY",
      files: {
        "packages/providers/src/bad.ts": "import { spawn } from \"node:child_process\";\nspawn(\"echo\");\n"
      }
    },
    {
      name: "production code bypassing provider execution admission",
      expectedCode: "PROVIDER_SESSION_ADMISSION",
      files: {
        "apps/server/src/bad.ts": "declare const provider: { createSession(): unknown }; provider[\"createSession\"]();\n"
      }
    },
    {
      name: "production code bypassing generation-bound proposal orchestration",
      expectedCode: "PROVIDER_PROPOSAL_ADMISSION",
      files: {
        "apps/server/src/bad.ts": "declare const turns: { processProposal(): unknown }; turns.processProposal();\n"
      }
    },
    {
      name: "credential-looking fields entering event schemas",
      expectedCode: "EVENT_CREDENTIAL_FIELD",
      files: {
        "packages/events/src/schemas.ts": "export const badEventShape = { clientToken: \"must-not-persist\" };\n"
      }
    },
    {
      name: "a leaf package violating the frozen dependency direction",
      expectedCode: "DEPENDENCY_DIRECTION",
      files: {
        "packages/verification/src/bad.ts": "import \"../../events/src/index.js\";\n"
      }
    },
    {
      name: "vision preprocessing importing whiteboard state",
      expectedCode: "DEPENDENCY_DIRECTION",
      files: {
        "packages/vision/src/bad.ts": "import \"../../whiteboard/src/index.js\";\n"
      }
    },
    {
      name: "external code importing vision's internal construction capability",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION",
      files: {
        "apps/server/src/bad.ts": "import \"../../../packages/vision/src/internal-artifact-construction.js\";\n"
      }
    },
    {
      name: "vision publicly re-exporting its internal construction capability",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/index.ts": "export * from \"./internal-artifact-construction.js\";\n"
      }
    },

    {
      name: "an unmapped new project package",
      expectedCode: "UNMAPPED_PACKAGE",
      files: {
        "packages/new-layer/src/index.ts": "export const value = 1;\n"
      }
    }
  ];

  for (const prohibitedCase of prohibitedCases) {
    it("fails closed on " + prohibitedCase.name, () => {
      const root = createFixture(prohibitedCase.files);
      const result = runChecker(root);
      expect(result.status).not.toBe(0);
      expect(checkerOutput(result)).toContain("[" + prohibitedCase.expectedCode + "]");
    });
  }
});
