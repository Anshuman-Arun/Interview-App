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

  it("allows the frozen snapshot constructor to consume the capability without exporting it", () => {
    const root = createFixture({
      "packages/vision/src/internal-artifact-construction.ts":
        "export const INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION = Symbol(\"snapshot\");\n",
      "packages/vision/src/types.ts":
        "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\n"
        + "export class ImageSnapshot { constructor(token: typeof secret) { if (token !== secret) throw new Error(\"bad\"); } }\n",
      "packages/vision/src/snapshot.ts":
        "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\n"
        + "import { ImageSnapshot } from \"./types.js\";\n"
        + "export function create() { return new ImageSnapshot(secret); }\n"
    });
    const result = runChecker(root);
    expect(checkerOutput(result)).toContain("Architecture boundary checks passed");
    expect(result.status).toBe(0);
  });

  it("allows type-only references to the internal vision construction capability", () => {
    const root = createFixture({
      "packages/vision/src/internal-artifact-construction.ts":
        "export const INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION = Symbol(\"snapshot\");\n",
      "packages/vision/src/types.ts":
        "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\n"
        + "export type ConstructionToken = typeof secret;\n"
        + "export class Example { constructor(_token: typeof secret) {} }\n"
    });
    const result = runChecker(root);
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
      name: "an unauthorized vision module importing the construction capability",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION",
      files: {
        "packages/vision/src/new-helper.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION } from \"./internal-artifact-construction.js\";\nvoid INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION;\n"
      }
    },
    {
      name: "vision indirectly re-exporting an imported construction capability",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/leak.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nexport { secret };\n"
      }
    },
    {
      name: "vision exposing a construction capability as an exported value",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/leak.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nexport const leaked = secret;\n"
      }
    },
    {
      name: "vision exposing a construction capability through an exported function",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/leak.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nexport function leaked() { return secret; }\n"
      }
    },
    {
      name: "authorized vision constructor module re-exporting a tainted local alias",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nconst alias = secret;\nexport { alias };\n"
      }
    },
    {
      name: "authorized vision constructor module re-exporting a tainted function alias",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nconst leak = () => secret;\nexport { leak };\n"
      }
    },
    {
      name: "authorized vision constructor module exporting a dynamic import of the construction capability",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "export const leak = import(\"./internal-artifact-construction.js\");\n"
      }
    },
    {
      name: "authorized vision constructor module exporting a CommonJS require of the construction capability",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "export const leak = require(\"./internal-artifact-construction.js\");\n"
      }
    },
    {
      name: "authorized vision constructor module re-exporting an import-equals construction capability",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "import secret = require(\"./internal-artifact-construction.js\");\nexport { secret };\n"
      }
    },
    {
      name: "authorized vision constructor module exporting a property of a required construction module",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "export const leak = require(\"./internal-artifact-construction.js\").INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION;\n"
      }
    },
    {
      name: "authorized vision constructor module wrapping a capability in a Promise",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nexport const leak = Promise.resolve(secret);\n"
      }
    },
    {
      name: "authorized vision constructor module wrapping a capability in a Set",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nexport const leak = new Set([secret]);\n"
      }
    },
    {
      name: "authorized vision constructor module returning an awaited dynamic-import capability",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "export async function leak() { return (await import(\"./internal-artifact-construction.js\")).INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION; }\n"
      }
    },
    {
      name: "authorized vision constructor module exporting a nested capability wrapper",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nexport const leak = { nested: { value: Promise.resolve(secret) } };\n"
      }
    },
    {
      name: "authorized vision constructor module exposing capability through an exported class",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nexport class Leak { static token = secret; }\n"
      }
    },
    {
      name: "exported vision container storing its sensitive constructor token on the instance",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/types.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nexport class ImageSnapshot { constructor(token: typeof secret) { if (token !== secret) throw new Error(\"bad\"); this.leak = token; } }\n"
      }
    },
    {
      name: "snapshot module using a same-named local wrapper instead of the real container import",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/snapshot.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nclass ImageSnapshot { constructor(readonly leak: unknown) {} }\nexport const leaked = new ImageSnapshot(secret);\n"
      }
    },
    {
      name: "authorized vision constructor module re-exporting a destructured capability alias",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nconst { token: alias } = { token: secret };\nexport { alias };\n"
      }
    },
    {
      name: "authorized vision constructor module re-exporting an assigned capability alias",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nlet alias;\nalias = secret;\nexport { alias };\n"
      }
    },
    {
      name: "authorized vision constructor module exposing capability through an object getter",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nexport const leak = { get token() { return secret; } };\n"
      }
    },
    {
      name: "authorized vision constructor module exposing capability through a function expression",
      expectedCode: "VISION_INTERNAL_CONSTRUCTION_EXPORT",
      files: {
        "packages/vision/src/processing.ts": "import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION as secret } from \"./internal-artifact-construction.js\";\nexport const leak = function () { return secret; };\n"
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
