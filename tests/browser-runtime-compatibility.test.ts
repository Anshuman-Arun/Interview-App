import { builtinModules } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeliveryIdSchema,
  EventIdSchema,
  GenerationIdSchema,
  InputEpisodeIdSchema,
  RequestIdSchema,
  SessionIdSchema,
  TurnIdSchema,
  UtteranceIdSchema,
  newDeliveryId,
  newEventId,
  newGenerationId,
  newInputEpisodeId,
  newRequestId,
  newSessionId,
  newTurnId,
  newUtteranceId
} from "../packages/domain/src/index.js";

const REPOSITORY_ROOT = process.cwd();
const BROWSER_SHARED_ROOTS = [
  "packages/domain/src/index.ts",
  "packages/delivery/src/index.ts"
] as const;

const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) => [
    name,
    name.startsWith("node:") ? name.slice("node:".length) : `node:${name}`
  ])
);

describe("browser runtime compatibility", () => {
  it.each([
    ["session", newSessionId, SessionIdSchema],
    ["event", newEventId, EventIdSchema],
    ["request", newRequestId, RequestIdSchema],
    ["utterance", newUtteranceId, UtteranceIdSchema],
    ["episode", newInputEpisodeId, InputEpisodeIdSchema],
    ["turn", newTurnId, TurnIdSchema],
    ["generation", newGenerationId, GenerationIdSchema],
    ["delivery", newDeliveryId, DeliveryIdSchema]
  ] as const)("keeps %s IDs browser-safe, schema-valid, and unique", (prefix, create, schema) => {
    const ids = Array.from({ length: 256 }, () => create());

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(schema.parse(id)).toBe(id);
      expect(id).toMatch(
        new RegExp(
          `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
          "u"
        )
      );
    }
  });

  it("keeps shared browser runtime roots free of transitive Node builtin imports", () => {
    const graph = collectRuntimeGraph(BROWSER_SHARED_ROOTS);
    const violations = graph.flatMap(({ path, specifiers }) =>
      specifiers
        .filter((specifier) => isNodeBuiltin(specifier))
        .map((specifier) => ({ path, specifier }))
    );

    expect(violations).toEqual([]);
    expect(graph.map((entry) => entry.path)).toContain("packages/domain/src/ids.ts");
    expect(graph.map((entry) => entry.path)).toContain("packages/domain/src/protocol.ts");
    expect(graph.map((entry) => entry.path)).toContain("packages/delivery/src/renderer.ts");
  });

  it("keeps the shared domain ID source independent of Node crypto", () => {
    const source = readFileSync(
      resolve(REPOSITORY_ROOT, "packages/domain/src/ids.ts"),
      "utf8"
    );

    expect(source).toContain("globalThis.crypto.randomUUID()");
    expect(source).not.toContain("node:crypto");
    expect(source).not.toMatch(/\bfrom\s+["']crypto["']/u);
  });
});

interface RuntimeGraphEntry {
  readonly path: string;
  readonly specifiers: readonly string[];
}

function collectRuntimeGraph(
  roots: readonly string[]
): readonly RuntimeGraphEntry[] {
  const queue = roots.map((path) => resolve(REPOSITORY_ROOT, path));
  const visited = new Set<string>();
  const entries: RuntimeGraphEntry[] = [];

  while (queue.length > 0) {
    const absolutePath = queue.shift();
    if (absolutePath === undefined || visited.has(absolutePath)) continue;
    visited.add(absolutePath);

    const source = readFileSync(absolutePath, "utf8");
    const specifiers = extractStaticModuleSpecifiers(source);
    entries.push({
      path: repositoryRelativePath(absolutePath),
      specifiers
    });

    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const dependency = resolveTypescriptDependency(
        dirname(absolutePath),
        specifier
      );
      if (dependency !== undefined && !visited.has(dependency)) {
        queue.push(dependency);
      }
    }
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function extractStaticModuleSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bexport\s+[^"'\n]*?\s+from\s+)["']([^"']+)["']/gu;

  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }

  return specifiers;
}

function resolveTypescriptDependency(
  parentDirectory: string,
  specifier: string
): string | undefined {
  const candidate = resolve(parentDirectory, specifier);
  const candidates = [
    candidate,
    candidate.endsWith(".js") ? `${candidate.slice(0, -3)}.ts` : undefined,
    candidate.endsWith(".mjs") ? `${candidate.slice(0, -4)}.mts` : undefined,
    resolve(candidate, "index.ts")
  ].filter((value): value is string => value !== undefined);

  return candidates.find((value) => existsSync(value));
}

function repositoryRelativePath(absolutePath: string): string {
  const path = relative(REPOSITORY_ROOT, absolutePath);
  if (path === ".." || path.startsWith("../") || path.startsWith("..\\")) {
    throw new Error("Browser runtime graph escaped repository root");
  }
  return path.replaceAll("\\", "/");
}

function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  if (NODE_BUILTINS.has(specifier)) return true;

  const slash = specifier.indexOf("/");
  if (slash === -1) return false;
  return NODE_BUILTINS.has(specifier.slice(0, slash));
}
