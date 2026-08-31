import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStableStagingFile } from "../packages/model-assets/src/filesystem.js";
import {
  AssetManifestSchema,
  ModelAssetManager,
  artifactInstallationKey,
  resolveAssetForCurrentPlatform,
  resolveAssetManifest,
  serializeAssetManifest,
  verifyArtifactFile,
  type AssetManifest
} from "../packages/model-assets/src/index.js";

interface FixtureServer {
  readonly server: Server;
  readonly baseUrl: string;
  readonly requestCount: () => number;
}

type FixtureHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => void | Promise<void>;

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise());
    });
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("local model asset manager", () => {
  it("accepts a strict valid manifest and rejects malformed or unsafe manifests", () => {
    const payload = Buffer.from("fixture-model-bytes");
    const valid = manifestFor(payload, "https://example.test/artifact.bin");
    expect(AssetManifestSchema.parse(valid)).toEqual(valid);

    const invalid: unknown[] = [
      { ...valid, schemaVersion: 2 },
      { ...valid, artifactId: "../escape" },
      { ...valid, filename: "../artifact.bin" },
      { ...valid, filename: "nested/artifact.bin" },
      { ...valid, filename: "nested\\artifact.bin" },
      { ...valid, filename: "CON" },
      { ...valid, filename: "manifest.json" },
      { ...valid, filename: "trailing." },
      { ...valid, sizeBytes: 0 },
      { ...valid, sha256: "ABC" },
      { ...valid, sourceUrl: "file:///tmp/model.bin" },
      { ...valid, sourceUrl: "https://user:pass@example.test/model.bin" },
      { ...valid, extra: true }
    ];

    for (const candidate of invalid) {
      expect(() => AssetManifestSchema.parse(candidate)).toThrow();
    }
  });

  it("rejects inherited and accessor-backed manifest data without invoking getters", () => {
    const payload = Buffer.from("prototype-manifest");
    const manifest = manifestFor(payload, "https://example.test/prototype.bin");

    const inheritedManifest = Object.create(manifest) as unknown;
    expect(AssetManifestSchema.safeParse(inheritedManifest).success).toBe(false);

    let getterReads = 0;
    const accessorManifest: Record<string, unknown> = { ...manifest };
    Object.defineProperty(accessorManifest, "sourceUrl", {
      enumerable: true,
      configurable: true,
      get() {
        getterReads += 1;
        return manifest.sourceUrl;
      }
    });
    expect(AssetManifestSchema.safeParse(accessorManifest).success).toBe(false);
    expect(getterReads).toBe(0);

    let manifestOwnKeyReads = 0;
    const proxiedManifest = new Proxy({ ...manifest }, {
      ownKeys(target) {
        manifestOwnKeyReads += 1;
        return Reflect.ownKeys(target);
      }
    });
    expect(AssetManifestSchema.safeParse(proxiedManifest).success).toBe(false);
    expect(manifestOwnKeyReads).toBe(0);

    const inheritedLicense = {
      ...manifest,
      license: Object.create({ name: "MIT" }) as unknown
    };
    expect(AssetManifestSchema.safeParse(inheritedLicense).success).toBe(false);

    const previousVariant = Object.getOwnPropertyDescriptor(Object.prototype, "variant");
    try {
      Object.defineProperty(Object.prototype, "variant", {
        configurable: true,
        value: "polluted-variant"
      });
      const parsed = AssetManifestSchema.parse(manifest);
      expect(parsed.variant).toBeUndefined();
    } finally {
      if (previousVariant === undefined) {
        Reflect.deleteProperty(Object.prototype, "variant");
      } else {
        Object.defineProperty(Object.prototype, "variant", previousVariant);
      }
    }

    const inheritedRequest = Object.create({
      familyId: manifest.familyId,
      version: manifest.version,
      platform: "linux",
      architecture: "x64"
    }) as unknown;
    const UnsafeResolver = resolveAssetManifest as unknown as (
      manifests: readonly unknown[],
      request: unknown
    ) => AssetManifest;
    expect(() => UnsafeResolver([manifest], inheritedRequest)).toThrow(
      expect.objectContaining({ code: "INVALID_MANIFEST" })
    );
  });

  it("validates current-platform resolver requests before reading fields", () => {
    const payload = Buffer.from("current-platform-resolver");
    const manifest = manifestFor(payload, "https://example.test/current-platform.bin");

    let getterReads = 0;
    const request: Record<string, unknown> = {
      version: manifest.version
    };
    Object.defineProperty(request, "familyId", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("resolver getter should not run");
      }
    });

    const UnsafeResolver = resolveAssetForCurrentPlatform as unknown as (
      manifests: readonly unknown[],
      requestValue: unknown
    ) => AssetManifest;
    expect(() => UnsafeResolver([manifest], request)).toThrow(
      expect.objectContaining({ code: "INVALID_MANIFEST" })
    );
    expect(getterReads).toBe(0);
  });

  it("rejects proxy and accessor-backed manifest collections without reading them", () => {
    const payload = Buffer.from("collection-isolation");
    const manifest = manifestFor(payload, "https://example.test/collection.bin");
    const request = {
      familyId: manifest.familyId,
      version: manifest.version,
      platform: "linux",
      architecture: "x64"
    };

    let accessorReads = 0;
    const accessorCollection: unknown[] = [manifest];
    Object.defineProperty(accessorCollection, "0", {
      enumerable: true,
      configurable: true,
      get() {
        accessorReads += 1;
        throw new Error("manifest collection getter should not run");
      }
    });
    const UnsafeResolver = resolveAssetManifest as unknown as (
      manifests: unknown,
      requestValue: unknown
    ) => AssetManifest;
    expect(() => UnsafeResolver(accessorCollection, request)).toThrow(
      expect.objectContaining({ code: "INVALID_MANIFEST" })
    );
    expect(accessorReads).toBe(0);

    let proxyReads = 0;
    const proxiedCollection = new Proxy([manifest], {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => UnsafeResolver(proxiedCollection, request)).toThrow(
      expect.objectContaining({ code: "INVALID_MANIFEST" })
    );
    expect(proxyReads).toBe(0);
  });

  it("resolves platform, architecture, and variant deterministically", () => {
    const payload = Buffer.from("resolver");
    const base = AssetManifestSchema.parse({
      ...manifestFor(payload, "https://example.test/base.bin"),
      platform: undefined,
      architecture: undefined
    });
    const linux = AssetManifestSchema.parse({
      ...manifestFor(payload, "https://example.test/linux.bin"),
      artifactId: "linux",
      platform: "linux",
      architecture: undefined
    });
    const linuxX64 = manifestFor(payload, "https://example.test/linux-x64.bin", {
      artifactId: "linux-x64",
      platform: "linux",
      architecture: "x64"
    });
    const avx = manifestFor(payload, "https://example.test/avx.bin", {
      artifactId: "linux-x64-avx",
      platform: "linux",
      architecture: "x64",
      variant: "avx2"
    });

    expect(resolveAssetManifest([base, linux, linuxX64, avx], {
      familyId: "fixture",
      version: "1.0.0",
      platform: "linux",
      architecture: "x64"
    }).artifactId).toBe("linux-x64");

    expect(resolveAssetManifest([base, linux, linuxX64, avx], {
      familyId: "fixture",
      version: "1.0.0",
      platform: "linux",
      architecture: "x64",
      variant: "avx2"
    }).artifactId).toBe("linux-x64-avx");
  });

  it("fails explicitly for unsupported and ambiguous platform resolution", () => {
    const payload = Buffer.from("resolver");
    const linux = manifestFor(payload, "https://example.test/linux.bin", {
      artifactId: "linux",
      platform: "linux",
      architecture: "x64"
    });

    expect(() => resolveAssetManifest([linux], {
      familyId: "fixture",
      version: "1.0.0",
      platform: "win32",
      architecture: "x64"
    })).toThrow(expect.objectContaining({ code: "UNSUPPORTED_PLATFORM" }));

    const duplicate = { ...linux, sourceUrl: "https://mirror.test/linux.bin" };
    expect(() => resolveAssetManifest([linux, duplicate], {
      familyId: "fixture",
      version: "1.0.0",
      platform: "linux",
      architecture: "x64"
    })).toThrow(expect.objectContaining({ code: "AMBIGUOUS_ARTIFACT" }));
  });

  it("downloads, verifies, atomically installs, lists, and exposes safe diagnostics", async () => {
    const payload = Buffer.from("valid remote artifact bytes");
    const fixture = await startFixtureServer((_request, response) => {
      response.writeHead(200, { "Content-Length": String(payload.byteLength) });
      response.end(payload);
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");

    const installedPath = await manager.install(manifest);
    expect(await readFile(installedPath)).toEqual(payload);
    expect(await manager.verifyInstalledArtifact(manifest)).toBe(true);
    expect(await manager.getInstalledPath(manifest)).toBe(installedPath);
    expect((await manager.inspect(manifest)).status).toBe("INSTALLED");
    expect(fixture.requestCount()).toBe(1);

    const list = await manager.listInstalledArtifacts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      artifactId: manifest.artifactId,
      familyId: manifest.familyId,
      version: manifest.version,
      sha256: manifest.sha256,
      byteSize: payload.byteLength
    });

    const diagnostics = await manager.getDiagnosticMetadata(manifest);
    const serialized = JSON.stringify(diagnostics);
    expect(diagnostics.status).toBe("INSTALLED");
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(fixture.baseUrl);
  });

  it("lists installed variants in deterministic order", async () => {
    const payload = Buffer.from("variant-order");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const manager = managerFor(root);

    const variantZ = manifestFor(payload, "https://example.test/z.bin", {
      artifactId: "multi",
      variant: "z"
    });
    const variantA = manifestFor(payload, "https://example.test/a.bin", {
      artifactId: "multi",
      variant: "a"
    });
    await manager.importLocal(variantZ, source);
    await manager.importLocal(variantA, source);

    const listed = await manager.listInstalledArtifacts();
    expect(listed.map((entry) => entry.variant)).toEqual(["a", "z"]);
  });

  it("orders otherwise-identical installed artifact types deterministically", async () => {
    const payload = Buffer.from("type-order");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const manager = managerFor(root);

    const model = manifestFor(payload, "https://example.test/model.bin", {
      artifactId: "typed",
      type: "MODEL"
    });
    const config = manifestFor(payload, "https://example.test/config.bin", {
      artifactId: "typed",
      type: "CONFIG"
    });

    await manager.importLocal(model, source);
    await manager.importLocal(config, source);

    const listed = await manager.listInstalledArtifacts();
    expect(listed.map((entry) => entry.type)).toEqual(["CONFIG", "MODEL"]);
  });

  it("reuses a verified installed artifact without another download", async () => {
    const payload = Buffer.from("already-installed");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);

    const fixture = await startFixtureServer((_request, response) => response.end(payload));
    const manager = managerFor(root);
    const imported = manifestFor(payload, "https://example.test/original.bin");
    await manager.importLocal(imported, source);

    const mirror = { ...imported, sourceUrl: fixture.baseUrl + "/artifact" };
    const installed = await manager.install(mirror);

    expect(await readFile(installed)).toEqual(payload);
    expect(fixture.requestCount()).toBe(0);
  });

  it("repairs a corrupted installed artifact through the verified staging path", async () => {
    const payload = Buffer.from("repair-me");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const fixture = await startFixtureServer((_request, response) => response.end(payload));
    const manager = managerFor(root);
    const imported = manifestFor(payload, "https://example.test/original.bin");
    const installed = await manager.importLocal(imported, source);
    await writeFile(installed, Buffer.from("corrupt!!"));

    const remote = { ...imported, sourceUrl: fixture.baseUrl + "/artifact" };
    const repaired = await manager.install(remote);

    expect(await readFile(repaired)).toEqual(payload);
    expect(await manager.verifyInstalledArtifact(remote)).toBe(true);
    expect(fixture.requestCount()).toBe(1);
  });

  it("does not delete a corrupt installation when replacement download fails", async () => {
    const payload = Buffer.from("failed-repair");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);

    const fixture = await startFixtureServer((_request, response) => {
      response.writeHead(503);
      response.end("unavailable");
    });
    const manager = managerFor(root);
    const imported = manifestFor(payload, "https://example.test/original.bin");
    const installed = await manager.importLocal(imported, source);
    await writeFile(installed, Buffer.from("corrupt-data!"));

    const remote = { ...imported, sourceUrl: fixture.baseUrl + "/artifact" };
    await expect(manager.install(remote)).rejects.toMatchObject({ code: "HTTP_STATUS" });

    expect(await manager.inspect(imported)).toMatchObject({
      status: "CORRUPT"
    });
    const installation = path.join(root, "artifacts", artifactInstallationKey(imported));
    expect((await readdir(installation)).sort()).toEqual([
      imported.filename,
      "manifest.json"
    ].sort());
  });

  it("treats malformed cached manifest metadata as corruption and repairs it", async () => {
    const payload = Buffer.from("repair-metadata");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const fixture = await startFixtureServer((_request, response) => response.end(payload));
    const manager = managerFor(root);
    const imported = manifestFor(payload, "https://example.test/original.bin");
    await manager.importLocal(imported, source);

    const installation = path.join(root, "artifacts", artifactInstallationKey(imported));
    await writeFile(path.join(installation, "manifest.json"), "{not-json");
    expect(await manager.inspect(imported)).toMatchObject({
      status: "CORRUPT",
      errorCode: "CORRUPT_INSTALLATION"
    });

    const remote = { ...imported, sourceUrl: fixture.baseUrl + "/artifact" };
    await manager.install(remote);
    expect(await manager.verifyInstalledArtifact(remote)).toBe(true);
  });

  it("rejects SHA-256 mismatch and never publishes the staged bytes", async () => {
    const payload = Buffer.from("actual bytes");
    const fixture = await startFixtureServer((_request, response) => response.end(payload));
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact", {
      sha256: "0".repeat(64)
    });

    await expect(manager.install(manifest)).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
    expect(await manager.inspect(manifest)).toMatchObject({
      status: "CORRUPT",
      errorCode: "DIGEST_MISMATCH"
    });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("rejects a response whose size differs from the manifest", async () => {
    const expected = Buffer.from("expected-size");
    const shorter = Buffer.from("short");
    const fixture = await startFixtureServer((_request, response) => {
      response.writeHead(200, { "Content-Length": String(shorter.byteLength) });
      response.end(shorter);
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(expected, fixture.baseUrl + "/artifact");

    await expect(manager.install(manifest)).rejects.toMatchObject({ code: "SIZE_MISMATCH" });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
  });

  it("rejects a cleanly-ended chunked response that is shorter than the manifest", async () => {
    const expected = Buffer.from("chunked-expected");
    const shorter = Buffer.from("short");
    const fixture = await startFixtureServer((_request, response) => {
      response.write(shorter);
      response.end();
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(expected, fixture.baseUrl + "/artifact");

    await expect(manager.install(manifest)).rejects.toMatchObject({
      code: "SIZE_MISMATCH"
    });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("stops oversized downloads before publication", async () => {
    const expected = Buffer.from("12345");
    const oversized = Buffer.from("123456");
    const fixture = await startFixtureServer((_request, response) => {
      response.writeHead(200, { "Content-Length": String(oversized.byteLength) });
      response.end(oversized);
    });
    const root = await newRoot();
    const manager = managerFor(root, { maxArtifactBytes: expected.byteLength });
    const manifest = manifestFor(expected, fixture.baseUrl + "/artifact");

    await expect(manager.install(manifest)).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
  });

  it("bounds chunked downloads even when Content-Length is absent", async () => {
    const expected = Buffer.from("12345");
    const fixture = await startFixtureServer((_request, response) => {
      response.write("123");
      response.end("456");
    });
    const root = await newRoot();
    const manager = managerFor(root, { maxArtifactBytes: expected.byteLength });
    const manifest = manifestFor(expected, fixture.baseUrl + "/artifact");

    await expect(manager.install(manifest)).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("cleans up an interrupted download without publishing a partial artifact", async () => {
    const payload = Buffer.from("interrupted-download-payload");
    const fixture = await startFixtureServer((_request, response) => {
      response.writeHead(200);
      response.write(payload.subarray(0, 4));
      response.destroy();
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");

    await expect(manager.install(manifest)).rejects.toBeInstanceOf(Error);
    expect((await manager.inspect(manifest)).status).toBe("FAILED");
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("supports cancellation and removes the incomplete staging directory", async () => {
    const payload = Buffer.from("cancel-me");
    const started = deferred<void>();
    const release = deferred<void>();
    const fixture = await startFixtureServer(async (_request, response) => {
      response.writeHead(200, { "Content-Length": String(payload.byteLength) });
      response.write(payload.subarray(0, 2));
      started.resolve();
      await release.promise;
      response.end(payload.subarray(2));
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");
    const controller = new AbortController();

    const operation = manager.install(manifest, controller.signal);
    await started.promise;
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: "CANCELLED" });
    release.resolve();
    await eventually(async () => (await readdir(path.join(root, "tmp"))).length === 0);
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
  });

  it("fails safely if cache topology changes during a download", async () => {
    if (process.platform === "win32") return;

    const payload = Buffer.from("topology-change");
    const started = deferred<void>();
    const release = deferred<void>();
    const fixture = await startFixtureServer(async (_request, response) => {
      response.writeHead(200, { "Content-Length": String(payload.byteLength) });
      response.write(payload.subarray(0, 2));
      started.resolve();
      await release.promise;
      response.end(payload.subarray(2));
    });

    const root = await newRoot();
    const outside = await newRoot();
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "keep-me");
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");

    const installation = manager.install(manifest);
    await started.promise;
    await rm(path.join(root, "artifacts"), { recursive: true, force: true });
    await symlink(outside, path.join(root, "artifacts"), "dir");
    release.resolve();

    await expect(installation).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readFile(sentinel, "utf8")).toBe("keep-me");
  });

  it("rejects replacement of the staging directory during transfer", async () => {
    const payload = Buffer.from("staging-replacement");
    const started = deferred<void>();
    const release = deferred<void>();
    const fixture = await startFixtureServer(async (_request, response) => {
      response.writeHead(200, { "Content-Length": String(payload.byteLength) });
      response.write(payload.subarray(0, 2));
      started.resolve();
      await release.promise;
      response.end(payload.subarray(2));
    });

    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");

    const installation = manager.install(manifest);
    await started.promise;

    const temporaryEntries = await readdir(path.join(root, "tmp"));
    expect(temporaryEntries).toHaveLength(1);
    const stagingName = temporaryEntries[0];
    if (stagingName === undefined) throw new Error("Expected one staging directory.");
    const staging = path.join(root, "tmp", stagingName);
    const detached = staging + "-detached";
    await rename(staging, detached);
    await mkdir(staging);

    release.resolve();

    await expect(installation).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    await rm(detached, { recursive: true, force: true });
  });

  it("refuses a replaced staging directory before creating payload bytes", async () => {
    if (process.platform === "win32") return;

    const root = await newRoot();
    const outside = await newRoot();
    const staging = path.join(root, "staging");
    const detached = path.join(root, "staging-original");
    await mkdir(staging);
    const identity = await lstat(staging, { bigint: true });

    await rename(staging, detached);
    await symlink(outside, staging, "dir");

    await expect(createStableStagingFile(
      staging,
      "payload.bin",
      { device: identity.dev, inode: identity.ino }
    )).rejects.toMatchObject({ code: "UNSAFE_PATH" });

    expect(await readdir(outside)).toEqual([]);
  });

  it("does not start network work for an already-cancelled request", async () => {
    const payload = Buffer.from("cancel-before-start");
    const fixture = await startFixtureServer((_request, response) => response.end(payload));
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");
    const controller = new AbortController();
    controller.abort();

    await expect(manager.install(manifest, controller.signal)).rejects.toMatchObject({
      code: "CANCELLED"
    });
    expect(fixture.requestCount()).toBe(0);
  });

  it("enforces an overall download timeout", async () => {
    const payload = Buffer.from("timeout");
    const fixture = await startFixtureServer(async () => {
      await new Promise<void>(() => undefined);
    });
    const root = await newRoot();
    const manager = managerFor(root, { downloadTimeoutMs: 40 });
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");

    await expect(manager.install(manifest)).rejects.toMatchObject({ code: "DOWNLOAD_TIMEOUT" });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
  });

  it("rejects oversized response headers without publishing bytes", async () => {
    const payload = Buffer.from("oversized-headers");
    const fixture = await startFixtureServer((_request, response) => {
      response.setHeader("X-Oversized-Fixture", "x".repeat(20 * 1024));
      response.end(payload);
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");

    await expect(manager.install(manifest)).rejects.toMatchObject({
      code: "NETWORK_ERROR"
    });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("rejects non-success HTTP responses without publishing bytes", async () => {
    const payload = Buffer.from("http-status");
    const fixture = await startFixtureServer((_request, response) => {
      response.writeHead(404);
      response.end("not found");
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/missing");

    await expect(manager.install(manifest)).rejects.toMatchObject({ code: "HTTP_STATUS" });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("rejects redirects without a Location header", async () => {
    const payload = Buffer.from("redirect-location");
    const fixture = await startFixtureServer((_request, response) => {
      response.writeHead(302);
      response.end();
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/redirect");

    await expect(manager.install(manifest)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
  });

  it("rejects invalid Content-Length metadata", async () => {
    const payload = Buffer.from("content-length");
    const fixture = await startFixtureServer((_request, response) => {
      response.setHeader("Content-Length", "not-a-number");
      response.end(payload);
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");

    await expect(manager.install(manifest)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
  });

  it("rejects an initial URL whose canonical encoding exceeds the URL limit", async () => {
    const payload = Buffer.from("canonical-url-limit");
    const root = await newRoot();
    const manager = managerFor(root);
    const sourceUrl = "https://example.test/" + "é".repeat(700);
    expect(sourceUrl.length).toBeLessThan(2_048);
    expect(new URL(sourceUrl).href.length).toBeGreaterThan(2_048);
    const manifest = manifestFor(payload, sourceUrl);

    await expect(manager.install(manifest)).rejects.toMatchObject({
      code: "UNSAFE_REDIRECT"
    });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("rejects redirect targets above the URL-length safety limit", async () => {
    const payload = Buffer.from("redirect-too-long");
    const fixture = await startFixtureServer((_request, response) => {
      response.writeHead(302, {
        Location: "/artifact?" + "x".repeat(2_100)
      });
      response.end();
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/start");

    await expect(manager.install(manifest)).rejects.toMatchObject({
      code: "UNSAFE_REDIRECT"
    });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
  });

  it("follows bounded same-origin redirects and rejects redirect loops", async () => {
    const payload = Buffer.from("redirected");
    const fixture = await startFixtureServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { Location: "/artifact" });
        response.end();
        return;
      }
      if (request.url === "/loop") {
        response.writeHead(302, { Location: "/loop" });
        response.end();
        return;
      }
      response.end(payload);
    });
    const root = await newRoot();
    const manager = managerFor(root, { maxRedirects: 1 });

    const valid = manifestFor(payload, fixture.baseUrl + "/start");
    expect(await readFile(await manager.install(valid))).toEqual(payload);

    const loop = manifestFor(payload, fixture.baseUrl + "/loop", { artifactId: "loop" });
    await expect(manager.install(loop)).rejects.toMatchObject({ code: "REDIRECT_LIMIT" });
  });

  it("rejects cross-origin redirects by default", async () => {
    const payload = Buffer.from("cross-origin");
    const target = await startFixtureServer((_request, response) => response.end(payload));
    const redirect = await startFixtureServer((_request, response) => {
      response.writeHead(302, { Location: target.baseUrl + "/artifact" });
      response.end();
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, redirect.baseUrl + "/start");

    await expect(manager.install(manifest)).rejects.toMatchObject({ code: "UNSAFE_REDIRECT" });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
  });

  it("allows an explicitly configured cross-origin redirect", async () => {
    const payload = Buffer.from("allowed-cross-origin");
    const target = await startFixtureServer((_request, response) => response.end(payload));
    const redirect = await startFixtureServer((_request, response) => {
      response.writeHead(302, { Location: target.baseUrl + "/artifact" });
      response.end();
    });
    const root = await newRoot();
    const manager = managerFor(root, { allowCrossOriginRedirects: true });
    const manifest = manifestFor(payload, redirect.baseUrl + "/start");

    const installed = await manager.install(manifest);
    expect(await readFile(installed)).toEqual(payload);
    expect(target.requestCount()).toBe(1);
  });

  it("rejects redirect URLs containing embedded credentials", async () => {
    const payload = Buffer.from("credential-redirect");
    const fixture = await startFixtureServer((_request, response) => {
      response.writeHead(302, {
        Location: "http://user:pass@127.0.0.1:1/artifact"
      });
      response.end();
    });
    const root = await newRoot();
    const manager = managerFor(root, { allowCrossOriginRedirects: true });
    const manifest = manifestFor(payload, fixture.baseUrl + "/start");

    await expect(manager.install(manifest)).rejects.toMatchObject({
      code: "UNSAFE_REDIRECT"
    });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
  });

  it("keeps partial bytes invisible until atomic publication", async () => {
    const payload = Buffer.from("atomic-publish");
    const started = deferred<void>();
    const release = deferred<void>();
    const fixture = await startFixtureServer(async (_request, response) => {
      response.writeHead(200, { "Content-Length": String(payload.byteLength) });
      response.write(payload.subarray(0, 3));
      started.resolve();
      await release.promise;
      response.end(payload.subarray(3));
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");

    const installation = manager.install(manifest);
    await started.promise;
    expect((await manager.inspect(manifest)).status).toBe("DOWNLOADING");
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    await expect(manager.getInstalledPath(manifest)).rejects.toMatchObject({ code: "NOT_INSTALLED" });

    release.resolve();
    const installed = await installation;
    expect(await readFile(installed)).toEqual(payload);
    expect((await manager.inspect(manifest)).status).toBe("INSTALLED");
  });

  it("imports local files only after enforcing size and digest", async () => {
    const payload = Buffer.from("local-import");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/local-import.bin");

    const installed = await manager.importLocal(manifest, source);
    expect(await readFile(installed)).toEqual(payload);

    const wrong = path.join(sourceRoot, "wrong.bin");
    await writeFile(wrong, Buffer.from("wrong"));
    const other = { ...manifest, artifactId: "other" };
    await expect(manager.importLocal(other, wrong)).rejects.toMatchObject({ code: "SIZE_MISMATCH" });

    const sameSizeWrongDigest = path.join(sourceRoot, "wrong-digest.bin");
    await writeFile(sameSizeWrongDigest, Buffer.alloc(payload.byteLength, 0x78));
    const digestMismatch = { ...manifest, artifactId: "digest-mismatch" };
    await expect(manager.importLocal(digestMismatch, sameSizeWrongDigest)).rejects.toMatchObject({
      code: "DIGEST_MISMATCH"
    });
  });

  it("rejects a directory as a local import source without publishing it", async () => {
    const payload = Buffer.from("directory-source");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const sourceDirectory = path.join(sourceRoot, "source-directory");
    await mkdir(sourceDirectory);

    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/directory-source.bin");

    await expect(manager.importLocal(manifest, sourceDirectory)).rejects.toMatchObject({
      code: "UNSAFE_PATH"
    });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("coalesces duplicate installs and lets one waiter cancel without aborting another", async () => {
    const payload = Buffer.from("coalesced");
    const started = deferred<void>();
    const release = deferred<void>();
    const fixture = await startFixtureServer(async (_request, response) => {
      response.writeHead(200, { "Content-Length": String(payload.byteLength) });
      response.write(payload.subarray(0, 2));
      started.resolve();
      await release.promise;
      response.end(payload.subarray(2));
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");
    const firstController = new AbortController();

    const first = manager.install(manifest, firstController.signal);
    const second = manager.install(manifest);
    await started.promise;
    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    release.resolve();

    const installed = await second;
    expect(await readFile(installed)).toEqual(payload);
    expect(fixture.requestCount()).toBe(1);
  });

  it("starts fresh after the last waiter cancels an in-flight install", async () => {
    const payload = Buffer.from("retry-after-cancel");
    const firstStarted = deferred<void>();
    const releaseFirstHandler = deferred<void>();
    let requestNumber = 0;
    const fixture = await startFixtureServer(async (_request, response) => {
      requestNumber += 1;
      if (requestNumber === 1) {
        response.writeHead(200, { "Content-Length": String(payload.byteLength) });
        response.write(payload.subarray(0, 2));
        firstStarted.resolve();
        await releaseFirstHandler.promise;
        response.end(payload.subarray(2));
        return;
      }
      response.writeHead(200, { "Content-Length": String(payload.byteLength) });
      response.end(payload);
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");
    const controller = new AbortController();

    const first = manager.install(manifest, controller.signal);
    await firstStarted.promise;
    controller.abort();
    const second = manager.install(manifest);

    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    const installed = await second;
    releaseFirstHandler.resolve();

    expect(await readFile(installed)).toEqual(payload);
    expect(fixture.requestCount()).toBe(2);
  });

  it("rejects a symlink as a local import source", async () => {
    if (process.platform === "win32") return;

    const payload = Buffer.from("local-symlink");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const target = path.join(sourceRoot, "target.bin");
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(target, payload);
    await symlink(target, source, "file");
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/local-symlink.bin");

    await expect(manager.importLocal(manifest, source)).rejects.toMatchObject({
      code: "UNSAFE_PATH"
    });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
  });

  it("keeps different artifacts independent under concurrent cache reservations", async () => {
    const remotePayload = Buffer.from("12345");
    const localPayload = Buffer.from("abcde");
    const started = deferred<void>();
    const release = deferred<void>();
    const fixture = await startFixtureServer(async (_request, response) => {
      response.writeHead(200, { "Content-Length": String(remotePayload.byteLength) });
      response.write(remotePayload.subarray(0, 2));
      started.resolve();
      await release.promise;
      response.end(remotePayload.subarray(2));
    });

    const root = await newRoot();
    const sourceRoot = await newRoot();
    const localSource = path.join(sourceRoot, "local.bin");
    await writeFile(localSource, localPayload);
    const remote = manifestFor(remotePayload, fixture.baseUrl + "/remote", {
      artifactId: "remote"
    });
    const local = manifestFor(localPayload, "https://example.test/local.bin", {
      artifactId: "local"
    });
    const manager = managerFor(root, {
      maxArtifactBytes: 5,
      maxCacheBytes: managedArtifactBytes(remote) + managedArtifactBytes(local)
    });

    const remoteInstall = manager.install(remote);
    await started.promise;
    const localInstalled = await manager.importLocal(local, localSource);
    expect(await readFile(localInstalled)).toEqual(localPayload);

    release.resolve();
    const remoteInstalled = await remoteInstall;
    expect(await readFile(remoteInstalled)).toEqual(remotePayload);
    expect(await manager.listInstalledArtifacts()).toHaveLength(2);
  });

  it("shares cache reservations across manager instances using the same root", async () => {
    const firstPayload = Buffer.from("shared-root-one");
    const secondPayload = Buffer.from("shared-root-two");
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const fixture = await startFixtureServer(async (request, response) => {
      if (request.url === "/first") {
        response.writeHead(200, { "Content-Length": String(firstPayload.byteLength) });
        response.write(firstPayload.subarray(0, 2));
        firstStarted.resolve();
        await releaseFirst.promise;
        response.end(firstPayload.subarray(2));
        return;
      }
      response.end(secondPayload);
    });

    const root = await newRoot();
    const first = manifestFor(firstPayload, fixture.baseUrl + "/first", {
      artifactId: "one"
    });
    const second = manifestFor(secondPayload, fixture.baseUrl + "/second", {
      artifactId: "two"
    });
    const cacheLimit = Math.max(managedArtifactBytes(first), managedArtifactBytes(second));
    const managerOne = managerFor(root, { maxCacheBytes: cacheLimit });
    const managerTwo = managerFor(root, { maxCacheBytes: cacheLimit });

    const firstInstall = managerOne.install(first);
    await firstStarted.promise;

    await expect(managerTwo.install(second)).rejects.toMatchObject({
      code: "CACHE_LIMIT_EXCEEDED"
    });
    expect(fixture.requestCount()).toBe(1);

    releaseFirst.resolve();
    await expect(firstInstall).resolves.toEqual(expect.any(String));
  });

  it("does not pool one staging overage against another install's unused reservation", async () => {
    const firstPayload = Buffer.alloc(64, 1);
    const secondPayload = Buffer.alloc(64, 2);
    const thirdPayload = Buffer.alloc(64, 3);
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const fixture = await startFixtureServer(async (request, response) => {
      if (request.url === "/first") {
        response.writeHead(200, { "Content-Length": String(firstPayload.byteLength) });
        response.write(firstPayload.subarray(0, 2));
        firstStarted.resolve();
        await releaseFirst.promise;
        response.end(firstPayload.subarray(2));
        return;
      }
      if (request.url === "/second") {
        response.writeHead(200, { "Content-Length": String(secondPayload.byteLength) });
        response.write(secondPayload.subarray(0, 2));
        secondStarted.resolve();
        await releaseSecond.promise;
        response.end(secondPayload.subarray(2));
        return;
      }
      response.end(thirdPayload);
    });

    const root = await newRoot();
    const first = manifestFor(firstPayload, fixture.baseUrl + "/first", {
      artifactId: "over-one"
    });
    const second = manifestFor(secondPayload, fixture.baseUrl + "/second", {
      artifactId: "over-two"
    });
    const third = manifestFor(thirdPayload, fixture.baseUrl + "/third", {
      artifactId: "over-three"
    });
    const firstReservation = managedArtifactBytes(first);
    const totalLimit = firstReservation
      + managedArtifactBytes(second)
      + managedArtifactBytes(third);
    const managerOne = managerFor(root, { maxCacheBytes: totalLimit });
    const managerTwo = managerFor(root, { maxCacheBytes: totalLimit });
    const managerThree = managerFor(root, { maxCacheBytes: totalLimit });

    const firstInstall = managerOne.install(first);
    const secondInstall = managerTwo.install(second);
    await Promise.all([firstStarted.promise, secondStarted.promise]);

    const temporaryEntries = await readdir(path.join(root, "tmp"));
    const firstPrefix = artifactInstallationKey(first) + "-";
    const firstStagingName = temporaryEntries.find((entry) => entry.startsWith(firstPrefix));
    if (firstStagingName === undefined) {
      throw new Error("Expected first active staging directory.");
    }
    await writeFile(
      path.join(root, "tmp", firstStagingName, "external-overage.bin"),
      Buffer.alloc(firstReservation + 32, 9)
    );

    await expect(managerThree.install(third)).rejects.toMatchObject({
      code: "CACHE_LIMIT_EXCEEDED"
    });
    expect(fixture.requestCount()).toBe(2);

    releaseFirst.resolve();
    releaseSecond.resolve();
    await expect(firstInstall).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(secondInstall).resolves.toEqual(expect.any(String));
  });

  it("uses the strictest active cache limit across shared-root managers", async () => {
    const firstPayload = Buffer.from("strict-shared-one");
    const secondPayload = Buffer.from("strict-shared-two");
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const fixture = await startFixtureServer(async (request, response) => {
      if (request.url === "/first") {
        response.writeHead(200, { "Content-Length": String(firstPayload.byteLength) });
        response.write(firstPayload.subarray(0, 2));
        firstStarted.resolve();
        await releaseFirst.promise;
        response.end(firstPayload.subarray(2));
        return;
      }
      response.end(secondPayload);
    });

    const root = await newRoot();
    const first = manifestFor(firstPayload, fixture.baseUrl + "/first", {
      artifactId: "strict-one"
    });
    const second = manifestFor(secondPayload, fixture.baseUrl + "/second", {
      artifactId: "strict-two"
    });
    const strictLimit = managedArtifactBytes(first);
    const managerStrict = managerFor(root, { maxCacheBytes: strictLimit });
    const managerLoose = managerFor(root, {
      maxCacheBytes: strictLimit + managedArtifactBytes(second) + 1024
    });

    const firstInstall = managerStrict.install(first);
    await firstStarted.promise;

    await expect(managerLoose.install(second)).rejects.toMatchObject({
      code: "CACHE_LIMIT_EXCEEDED"
    });
    expect(fixture.requestCount()).toBe(1);

    releaseFirst.resolve();
    await expect(firstInstall).resolves.toEqual(expect.any(String));
  });

  it("blocks shared-root cleanup and removal while another manager is installing", async () => {
    const payload = Buffer.from("shared-root-busy");
    const started = deferred<void>();
    const release = deferred<void>();
    const fixture = await startFixtureServer(async (_request, response) => {
      response.writeHead(200, { "Content-Length": String(payload.byteLength) });
      response.write(payload.subarray(0, 2));
      started.resolve();
      await release.promise;
      response.end(payload.subarray(2));
    });

    const root = await newRoot();
    const managerOne = managerFor(root);
    const managerTwo = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");

    const installation = managerOne.install(manifest);
    await started.promise;

    await expect(managerTwo.cleanupTemporary()).rejects.toMatchObject({
      code: "ASSET_BUSY"
    });
    await expect(managerTwo.clearUnused([])).rejects.toMatchObject({
      code: "ASSET_BUSY"
    });
    await expect(managerTwo.remove(manifest)).rejects.toMatchObject({
      code: "ASSET_BUSY"
    });

    const temporaryEntries = await readdir(path.join(root, "tmp"));
    expect(temporaryEntries).toHaveLength(1);

    release.resolve();
    await expect(installation).resolves.toEqual(expect.any(String));
  });

  it("refuses removal while the same artifact is installing", async () => {
    const payload = Buffer.from("busy-remove");
    const started = deferred<void>();
    const release = deferred<void>();
    const fixture = await startFixtureServer(async (_request, response) => {
      response.writeHead(200, { "Content-Length": String(payload.byteLength) });
      response.write(payload.subarray(0, 2));
      started.resolve();
      await release.promise;
      response.end(payload.subarray(2));
    });
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");

    const installation = manager.install(manifest);
    await started.promise;
    await expect(manager.remove(manifest)).rejects.toMatchObject({ code: "ASSET_BUSY" });
    release.resolve();
    await installation;
    expect(await manager.verifyInstalledArtifact(manifest)).toBe(true);
  });

  it("treats unexpected installed-directory entries as corruption", async () => {
    const payload = Buffer.from("strict-layout");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);

    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/strict-layout.bin");
    await manager.importLocal(manifest, source);

    const installation = path.join(root, "artifacts", artifactInstallationKey(manifest));
    await writeFile(path.join(installation, "unexpected.txt"), "unexpected");

    expect(await manager.inspect(manifest)).toMatchObject({
      status: "CORRUPT",
      errorCode: "CORRUPT_INSTALLATION"
    });
    expect(await manager.verifyInstalledArtifact(manifest)).toBe(false);
    await expect(manager.getInstalledPath(manifest)).rejects.toMatchObject({
      code: "NOT_INSTALLED"
    });
    await manager.remove(manifest);
    expect((await manager.inspect(manifest)).status).toBe("NOT_PRESENT");
  });

  it("reports verification policy limits as FAILED rather than CORRUPT", async () => {
    const payload = Buffer.from("policy-limit");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);

    const installingManager = managerFor(root, {
      maxArtifactBytes: payload.byteLength
    });
    const manifest = manifestFor(payload, "https://example.test/policy-limit.bin");
    await installingManager.importLocal(manifest, source);

    const inspectingManager = managerFor(root, {
      maxArtifactBytes: payload.byteLength - 1
    });

    expect(await inspectingManager.inspect(manifest)).toMatchObject({
      status: "FAILED",
      errorCode: "ARTIFACT_TOO_LARGE"
    });
    await expect(inspectingManager.verifyInstalledArtifact(manifest)).rejects.toMatchObject({
      code: "ARTIFACT_TOO_LARGE"
    });
    await expect(inspectingManager.getInstalledPath(manifest)).rejects.toMatchObject({
      code: "ARTIFACT_TOO_LARGE"
    });
  });

  it("preserves policy-limit errors when install refuses destructive repair", async () => {
    const payload = Buffer.from("policy-install");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);

    const installingManager = managerFor(root, {
      maxArtifactBytes: payload.byteLength
    });
    const manifest = manifestFor(payload, "https://example.test/policy-install.bin");
    const installed = await installingManager.importLocal(manifest, source);

    const restrictiveManager = managerFor(root, {
      maxArtifactBytes: payload.byteLength - 1
    });
    await expect(restrictiveManager.install(manifest)).rejects.toMatchObject({
      code: "ARTIFACT_TOO_LARGE"
    });

    expect(await readFile(installed)).toEqual(payload);
  });

  it("detects corruption of a previously installed artifact", async () => {
    const payload = Buffer.from("good-bytes");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/good.bin");
    const installed = await manager.importLocal(manifest, source);

    await writeFile(installed, Buffer.from("bad!-bytes"));
    expect(await manager.verifyInstalledArtifact(manifest)).toBe(false);
    expect(await manager.inspect(manifest)).toMatchObject({
      status: "CORRUPT",
      errorCode: "DIGEST_MISMATCH"
    });
    await expect(manager.getInstalledPath(manifest)).rejects.toMatchObject({ code: "NOT_INSTALLED" });
    expect(await manager.listInstalledArtifacts()).toEqual([]);
  });

  it("removes one installed artifact and derives NOT_PRESENT from the filesystem", async () => {
    const payload = Buffer.from("remove-me");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/remove.bin");

    await manager.importLocal(manifest, source);
    await manager.remove(manifest);
    expect((await manager.inspect(manifest)).status).toBe("NOT_PRESENT");
    expect(await manager.listInstalledArtifacts()).toEqual([]);
  });

  it("keeps per-artifact two-file operations valid when maxListEntries is one", async () => {
    const payload = Buffer.from("two-file-layout");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);

    const first = manifestFor(payload, "https://example.test/one.bin", {
      artifactId: "one"
    });
    const second = manifestFor(payload, "https://example.test/two.bin", {
      artifactId: "two"
    });
    const manager = managerFor(root, {
      maxListEntries: 1,
      maxCacheBytes: managedArtifactBytes(first)
    });

    await manager.importLocal(first, source);
    expect((await manager.listInstalledArtifacts()).map((entry) => entry.artifactId)).toEqual(["one"]);

    await expect(manager.importLocal(second, source)).rejects.toMatchObject({
      code: "CACHE_LIMIT_EXCEEDED"
    });

    await manager.remove(first);
    expect((await manager.inspect(first)).status).toBe("NOT_PRESENT");
  });

  it("clears only manager-owned stale temporary entries", async () => {
    const payload = Buffer.from("cleanup");
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/cleanup.bin");
    await manager.inspect(manifest);

    const owned = path.join(
      root,
      "tmp",
      `${"a".repeat(64)}-00000000-0000-4000-8000-000000000000`
    );
    const foreign = path.join(root, "tmp", "foreign");
    await mkdir(owned);
    await mkdir(foreign);
    await writeFile(path.join(owned, "partial.bin"), "partial");
    await writeFile(path.join(foreign, "sentinel.txt"), "keep-me");

    await manager.cleanupTemporary();

    expect(await readdir(path.join(root, "tmp"))).toEqual(["foreign"]);
    expect(await readFile(path.join(foreign, "sentinel.txt"), "utf8")).toBe("keep-me");
  });

  it("fails temporary cleanup bounds before deleting any entry", async () => {
    const root = await newRoot();
    const manager = managerFor(root, { maxListEntries: 1 });
    const manifest = manifestFor(Buffer.from("seed"), "https://example.test/seed.bin");
    await manager.inspect(manifest);

    const first = path.join(
      root,
      "tmp",
      `${"1".repeat(64)}-00000000-0000-4000-8000-000000000000`
    );
    const second = path.join(
      root,
      "tmp",
      `${"2".repeat(64)}-00000000-0000-4000-8000-000000000000`
    );
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(first, "partial.bin"), "first");
    await writeFile(path.join(second, "partial.bin"), "second");

    await expect(manager.cleanupTemporary()).rejects.toMatchObject({
      code: "CACHE_LIMIT_EXCEEDED"
    });
    expect((await readdir(path.join(root, "tmp"))).sort()).toEqual([
      path.basename(first),
      path.basename(second)
    ].sort());
  });

  it("cleans crash-left manager removal tombstones", async () => {
    const root = await newRoot();
    const manager = managerFor(root);
    const tombstoneName = ".model-assets-delete-00000000-0000-4000-8000-000000000000";

    const artifactTombstone = path.join(root, "artifacts", tombstoneName);
    const temporaryTombstone = path.join(root, "tmp", tombstoneName);
    await mkdir(artifactTombstone);
    await mkdir(temporaryTombstone);
    await writeFile(path.join(artifactTombstone, "artifact.bin"), "artifact");
    await writeFile(path.join(temporaryTombstone, "partial.bin"), "partial");

    expect(await manager.clearUnused([])).toBe(1);
    await manager.cleanupTemporary();

    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("rejects proxy and accessor-backed keep collections before cleanup", async () => {
    const payload = Buffer.from("keep-collection");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/keep-collection.bin");
    await manager.importLocal(manifest, source);

    let accessorReads = 0;
    const accessorKeep: unknown[] = [manifest];
    Object.defineProperty(accessorKeep, "0", {
      enumerable: true,
      configurable: true,
      get() {
        accessorReads += 1;
        throw new Error("keep collection getter should not run");
      }
    });
    const UnsafeClear = manager.clearUnused.bind(manager) as unknown as (
      values: unknown
    ) => Promise<number>;
    await expect(UnsafeClear(accessorKeep)).rejects.toMatchObject({
      code: "INVALID_MANIFEST"
    });
    expect(accessorReads).toBe(0);

    let proxyReads = 0;
    const proxiedKeep = new Proxy([manifest], {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    await expect(UnsafeClear(proxiedKeep)).rejects.toMatchObject({
      code: "INVALID_MANIFEST"
    });
    expect(proxyReads).toBe(0);

    expect(await manager.verifyInstalledArtifact(manifest)).toBe(true);
  });

  it("deterministically clears unused installed artifacts", async () => {
    const firstPayload = Buffer.from("first");
    const secondPayload = Buffer.from("second");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const firstSource = path.join(sourceRoot, "first.bin");
    const secondSource = path.join(sourceRoot, "second.bin");
    await writeFile(firstSource, firstPayload);
    await writeFile(secondSource, secondPayload);

    const manager = managerFor(root);
    const first = manifestFor(firstPayload, "https://example.test/first.bin", { artifactId: "first" });
    const second = manifestFor(secondPayload, "https://example.test/second.bin", { artifactId: "second" });
    await manager.importLocal(first, firstSource);
    await manager.importLocal(second, secondSource);
    const foreign = path.join(root, "artifacts", "foreign.txt");
    await writeFile(foreign, "keep-me");

    expect(await manager.clearUnused([first])).toBe(1);
    expect(await manager.verifyInstalledArtifact(first)).toBe(true);
    expect(await manager.verifyInstalledArtifact(second)).toBe(false);
    expect(await readFile(foreign, "utf8")).toBe("keep-me");
  });

  it("allows cache and per-artifact limits to be configured independently", async () => {
    const payload = Buffer.from("1234");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const manifest = manifestFor(payload, "https://example.test/independent-limits.bin");
    const manager = managerFor(root, {
      maxArtifactBytes: managedArtifactBytes(manifest) + 100,
      maxCacheBytes: managedArtifactBytes(manifest)
    });

    const installed = await manager.importLocal(manifest, source);
    expect(await readFile(installed)).toEqual(payload);
  });

  it("rejects insufficient cache capacity before opening the network", async () => {
    const payload = Buffer.from("no-network-capacity");
    const fixture = await startFixtureServer((_request, response) => response.end(payload));
    const root = await newRoot();
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");
    const manager = managerFor(root, {
      maxArtifactBytes: payload.byteLength,
      maxCacheBytes: managedArtifactBytes(manifest) - 1
    });

    await expect(manager.install(manifest)).rejects.toMatchObject({
      code: "CACHE_LIMIT_EXCEEDED"
    });
    expect(fixture.requestCount()).toBe(0);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("enforces the configured aggregate artifact cache-size limit", async () => {
    const one = Buffer.from("123456");
    const two = Buffer.from("abcdef");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const oneSource = path.join(sourceRoot, "one.bin");
    const twoSource = path.join(sourceRoot, "two.bin");
    await writeFile(oneSource, one);
    await writeFile(twoSource, two);

    const first = manifestFor(one, "https://example.test/one.bin", { artifactId: "one" });
    const second = manifestFor(two, "https://example.test/two.bin", { artifactId: "two" });
    const manager = managerFor(root, {
      maxArtifactBytes: 10,
      maxCacheBytes: managedArtifactBytes(first)
    });
    await manager.importLocal(first, oneSource);
    await expect(manager.importLocal(second, twoSource)).rejects.toMatchObject({
      code: "CACHE_LIMIT_EXCEEDED"
    });
    expect(await manager.verifyInstalledArtifact(first)).toBe(true);
  });

  it("counts stale manager-owned staging bytes against the cache limit", async () => {
    const payload = Buffer.from("12345");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const manifest = manifestFor(payload, "https://example.test/stale-capacity.bin");
    const manager = managerFor(root, {
      maxArtifactBytes: 10,
      maxCacheBytes: managedArtifactBytes(manifest) + 5
    });
    await manager.inspect(manifest);

    const stale = path.join(
      root,
      "tmp",
      `${"b".repeat(64)}-00000000-0000-4000-8000-000000000000`
    );
    await mkdir(stale);
    await writeFile(path.join(stale, "partial.bin"), "123456");

    await expect(manager.importLocal(manifest, source)).rejects.toMatchObject({
      code: "CACHE_LIMIT_EXCEEDED"
    });
  });

  it("fails cache accounting closed on over-wide managed entries without starting HTTP", async () => {
    const payload = Buffer.from("wide-staging");
    const fixture = await startFixtureServer((_request, response) => response.end(payload));
    const root = await newRoot();
    const stale = path.join(
      root,
      "tmp",
      `${"d".repeat(64)}-00000000-0000-4000-8000-000000000000`
    );
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "one.bin"), "1");
    await writeFile(path.join(stale, "two.bin"), "2");
    await writeFile(path.join(stale, "three.bin"), "3");

    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");
    const manager = managerFor(root, {
      maxCacheBytes: managedArtifactBytes(manifest) + 1024
    });

    await expect(manager.install(manifest)).rejects.toMatchObject({
      code: "CACHE_LIMIT_EXCEEDED"
    });
    expect(fixture.requestCount()).toBe(0);

    await manager.cleanupTemporary();
    await expect(readdir(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks cache growth after reservation before atomic publication", async () => {
    const payload = Buffer.from("late-cache-growth");
    const started = deferred<void>();
    const release = deferred<void>();
    const fixture = await startFixtureServer(async (_request, response) => {
      response.writeHead(200, { "Content-Length": String(payload.byteLength) });
      response.write(payload.subarray(0, 2));
      started.resolve();
      await release.promise;
      response.end(payload.subarray(2));
    });

    const root = await newRoot();
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact", {
      artifactId: "late-growth"
    });
    const manager = managerFor(root, {
      maxArtifactBytes: payload.byteLength,
      maxCacheBytes: managedArtifactBytes(manifest)
    });

    const installation = manager.install(manifest);
    await started.promise;

    const stale = path.join(
      root,
      "tmp",
      `${"c".repeat(64)}-00000000-0000-4000-8000-000000000000`
    );
    await mkdir(stale);
    await writeFile(path.join(stale, "partial.bin"), "x");

    release.resolve();

    await expect(installation).rejects.toMatchObject({
      code: "CACHE_LIMIT_EXCEEDED"
    });
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    expect(await readdir(stale)).toEqual(["partial.bin"]);
  });

  it("provides standalone bounded file verification", async () => {
    const payload = Buffer.from("verify-me");
    const root = await newRoot();
    const file = path.join(root, "verify.bin");
    await writeFile(file, payload);

    const valid = await verifyArtifactFile(file, {
      sizeBytes: payload.byteLength,
      sha256: sha256(payload),
      maxBytes: payload.byteLength
    });
    expect(valid.ok).toBe(true);

    const invalid = await verifyArtifactFile(file, {
      sizeBytes: payload.byteLength,
      sha256: "0".repeat(64),
      maxBytes: payload.byteLength
    });
    expect(invalid).toMatchObject({ ok: false, reason: "DIGEST_MISMATCH" });
  });

  it("rejects malformed runtime inputs with model-asset errors", async () => {
    const root = await newRoot();
    const UnsafeManager = ModelAssetManager as unknown as new (options: unknown) => ModelAssetManager;
    const UnsafeResolver = resolveAssetManifest as unknown as (
      manifests: unknown,
      request: unknown
    ) => AssetManifest;
    const UnsafeVerifier = verifyArtifactFile as unknown as (
      filePath: unknown,
      expectations: unknown
    ) => Promise<unknown>;

    expect(() => new UnsafeManager(null)).toThrow(expect.objectContaining({
      code: "INVALID_CONFIGURATION"
    }));
    expect(() => new UnsafeManager({
      rootDir: root,
      maxArtifactBytes: "1024"
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    expect(() => UnsafeResolver(null, {
      familyId: "fixture",
      version: "1.0.0",
      platform: "linux",
      architecture: "x64"
    })).toThrow(expect.objectContaining({ code: "INVALID_MANIFEST" }));
    await expect(UnsafeVerifier(path.join(root, "missing.bin"), null)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
  });

  it("keeps generated installation paths contained and Windows-safe", async () => {
    const payload = Buffer.from("safe");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/safe.bin", {
      artifactId: "safe-artifact",
      filename: "portable-file_1.bin"
    });

    const installed = await manager.importLocal(manifest, source);
    const relative = path.relative(root, installed);
    expect(relative.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(path.basename(path.dirname(installed))).toBe(artifactInstallationKey(manifest));
    expect(path.basename(installed)).toBe("portable-file_1.bin");
  });

  it("rejects malformed runtime cancellation signals before side effects", async () => {
    const payload = Buffer.from("bad-signal");
    const fixture = await startFixtureServer((_request, response) => response.end(payload));
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    const verifyFile = path.join(sourceRoot, "verify.bin");
    await writeFile(source, payload);
    await writeFile(verifyFile, payload);

    const manager = managerFor(root);
    const manifest = manifestFor(payload, fixture.baseUrl + "/artifact");
    const UnsafeInstall = manager.install.bind(manager) as unknown as (
      manifest: unknown,
      signal: unknown
    ) => Promise<string>;
    const UnsafeImport = manager.importLocal.bind(manager) as unknown as (
      manifest: unknown,
      sourcePath: string,
      signal: unknown
    ) => Promise<string>;
    const UnsafeVerifier = verifyArtifactFile as unknown as (
      filePath: string,
      expectations: unknown,
      signal: unknown
    ) => Promise<unknown>;
    const malformedSignal = {
      aborted: false
    };

    await expect(UnsafeInstall(manifest, malformedSignal)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
    await expect(UnsafeImport(manifest, source, malformedSignal)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
    await expect(UnsafeVerifier(verifyFile, {
      sizeBytes: payload.byteLength,
      sha256: sha256(payload)
    }, malformedSignal)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });

    expect(fixture.requestCount()).toBe(0);
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });

  it("rejects getter-backed fake cancellation signals without invoking them", async () => {
    const payload = Buffer.from("fake-signal-getter");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/fake-signal.bin");

    let reads = 0;
    const fakeSignal: Record<string, unknown> = {};
    Object.defineProperty(fakeSignal, "aborted", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("fake signal getter should not run");
      }
    });

    const UnsafeInstall = manager.install.bind(manager) as unknown as (
      manifestValue: unknown,
      signal: unknown
    ) => Promise<string>;
    const UnsafeImport = manager.importLocal.bind(manager) as unknown as (
      manifestValue: unknown,
      sourcePath: string,
      signal: unknown
    ) => Promise<string>;
    const UnsafeVerifier = verifyArtifactFile as unknown as (
      filePath: string,
      expectations: unknown,
      signal: unknown
    ) => Promise<unknown>;

    await expect(UnsafeInstall(manifest, fakeSignal)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
    await expect(UnsafeImport(manifest, source, fakeSignal)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
    await expect(UnsafeVerifier(source, {
      sizeBytes: payload.byteLength,
      sha256: sha256(payload)
    }, fakeSignal)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
    expect(reads).toBe(0);

    const prototypeOnlySignal = Object.create(AbortSignal.prototype) as unknown;
    await expect(UnsafeInstall(manifest, prototypeOnlySignal)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });

    let proxyReads = 0;
    const realSignal = new AbortController().signal;
    const proxiedSignal = new Proxy(realSignal, {
      get(target, property, receiver) {
        if (property === "aborted") {
          proxyReads += 1;
          throw new Error("proxy signal getter should not run");
        }
        return Reflect.get(target, property, receiver);
      }
    });
    await expect(UnsafeInstall(manifest, proxiedSignal)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
    expect(proxyReads).toBe(0);

    const alteredController = new AbortController();
    let listenerReads = 0;
    Object.defineProperty(alteredController.signal, "addEventListener", {
      configurable: true,
      get() {
        listenerReads += 1;
        throw new Error("altered signal listener getter should not run");
      }
    });
    await expect(UnsafeInstall(manifest, alteredController.signal)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
    expect(listenerReads).toBe(0);
  });

  it("rejects malformed runtime redirect security configuration", async () => {
    const root = await newRoot();
    const UnsafeManager = ModelAssetManager as unknown as new (options: unknown) => ModelAssetManager;

    expect(() => new UnsafeManager({
      rootDir: root,
      maxArtifactBytes: 1024,
      allowCrossOriginRedirects: "false"
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it("rejects redirect limits above the package safety ceiling", async () => {
    const root = await newRoot();
    expect(() => managerFor(root, {
      maxRedirects: 21
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it("does not consume security-sensitive configuration through prototypes", async () => {
    const root = await newRoot();
    const UnsafeManager = ModelAssetManager as unknown as new (options: unknown) => ModelAssetManager;
    const inheritedManagerOptions = Object.create({
      maxArtifactBytes: 1024,
      allowCrossOriginRedirects: true
    }) as Record<string, unknown>;
    inheritedManagerOptions["rootDir"] = root;

    expect(() => new UnsafeManager(inheritedManagerOptions)).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIGURATION" })
    );

    const expectations = Object.create({
      sizeBytes: 1,
      sha256: "0".repeat(64)
    }) as Record<string, unknown>;
    const UnsafeVerifier = verifyArtifactFile as unknown as (
      filePath: string,
      expectations: unknown
    ) => Promise<unknown>;

    await expect(
      UnsafeVerifier(path.join(root, "missing.bin"), expectations)
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("rejects accessor-backed configuration without invoking getters", async () => {
    const root = await newRoot();
    const UnsafeManager = ModelAssetManager as unknown as new (options: unknown) => ModelAssetManager;
    const UnsafeVerifier = verifyArtifactFile as unknown as (
      filePath: string,
      expectations: unknown
    ) => Promise<unknown>;

    let managerGetterReads = 0;
    const managerOptions: Record<string, unknown> = {
      maxArtifactBytes: 1024
    };
    Object.defineProperty(managerOptions, "rootDir", {
      enumerable: true,
      get() {
        managerGetterReads += 1;
        throw new Error("manager getter should not run");
      }
    });
    expect(() => new UnsafeManager(managerOptions)).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIGURATION" })
    );
    expect(managerGetterReads).toBe(0);

    const file = path.join(root, "verify-accessor.bin");
    await writeFile(file, "x");
    let verifierGetterReads = 0;
    const expectations: Record<string, unknown> = {
      sha256: sha256(Buffer.from("x"))
    };
    Object.defineProperty(expectations, "sizeBytes", {
      enumerable: true,
      get() {
        verifierGetterReads += 1;
        throw new Error("verifier getter should not run");
      }
    });
    await expect(UnsafeVerifier(file, expectations)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
    expect(verifierGetterReads).toBe(0);

    let managerOwnKeyReads = 0;
    const proxiedManagerOptions = new Proxy({
      rootDir: root,
      maxArtifactBytes: 1024
    }, {
      ownKeys(target) {
        managerOwnKeyReads += 1;
        return Reflect.ownKeys(target);
      }
    });
    expect(() => new UnsafeManager(proxiedManagerOptions)).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIGURATION" })
    );
    expect(managerOwnKeyReads).toBe(0);

    let verifierOwnKeyReads = 0;
    const proxiedExpectations = new Proxy({
      sizeBytes: 1,
      sha256: sha256(Buffer.from("x"))
    }, {
      ownKeys(target) {
        verifierOwnKeyReads += 1;
        return Reflect.ownKeys(target);
      }
    });
    await expect(UnsafeVerifier(file, proxiedExpectations)).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
    expect(verifierOwnKeyReads).toBe(0);
  });

  it("rejects unknown manager option keys", async () => {
    const root = await newRoot();
    const UnsafeManager = ModelAssetManager as unknown as new (options: unknown) => ModelAssetManager;

    expect(() => new UnsafeManager({
      rootDir: root,
      maxArtifactBytes: 1024,
      maxCacheByte: 2048
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it("rejects null optional manager settings instead of silently defaulting", async () => {
    const root = await newRoot();
    const UnsafeManager = ModelAssetManager as unknown as new (options: unknown) => ModelAssetManager;

    for (const [name, value] of [
      ["downloadTimeoutMs", null],
      ["maxRedirects", null],
      ["maxListEntries", null]
    ] as const) {
      expect(() => new UnsafeManager({
        rootDir: root,
        maxArtifactBytes: 1024,
        [name]: value
      })).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    }
  });

  it("rejects unknown standalone verification expectation keys", async () => {
    const root = await newRoot();
    const file = path.join(root, "artifact.bin");
    const payload = Buffer.from("verifier-typo");
    await writeFile(file, payload);

    const UnsafeVerifier = verifyArtifactFile as unknown as (
      filePath: string,
      expectations: unknown
    ) => Promise<unknown>;

    await expect(UnsafeVerifier(file, {
      sizeBytes: payload.byteLength,
      sha256: sha256(payload),
      maxByte: payload.byteLength
    })).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION"
    });
  });

  it("rejects impossible standalone verification bounds before file access", async () => {
    const root = await newRoot();
    const missing = path.join(root, "missing.bin");

    await expect(verifyArtifactFile(missing, {
      sizeBytes: 10,
      sha256: "0".repeat(64),
      maxBytes: 9
    })).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });

    const UnsafeVerifier = verifyArtifactFile as unknown as (
      filePath: string,
      expectations: unknown
    ) => Promise<unknown>;
    await expect(UnsafeVerifier(missing, {
      sizeBytes: 10,
      sha256: "0".repeat(64),
      maxBytes: null
    })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("rejects timeout values that overflow Node.js timers", async () => {
    const root = await newRoot();
    expect(() => managerFor(root, {
      downloadTimeoutMs: 2_147_483_648
    })).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });

  it("rejects a malformed clearUnused collection at runtime", async () => {
    const root = await newRoot();
    const manager = managerFor(root);
    const UnsafeClear = manager.clearUnused.bind(manager) as unknown as (
      manifests: unknown
    ) => Promise<number>;

    await expect(UnsafeClear(null)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  });

  it("rejects a relative cache root before performing filesystem writes", async () => {
    expect(() => new ModelAssetManager({
      rootDir: "relative-model-cache",
      maxArtifactBytes: 1024
    })).toThrow(expect.objectContaining({ code: "INVALID_CACHE_ROOT" }));
  });

  it("rejects filesystem/share roots as cache roots", async () => {
    const filesystemRoot = path.parse(tmpdir()).root;
    expect(() => new ModelAssetManager({
      rootDir: filesystemRoot,
      maxArtifactBytes: 1024
    })).toThrow(expect.objectContaining({ code: "INVALID_CACHE_ROOT" }));
  });

  it("rejects a cache path that resolves to the filesystem root", async () => {
    if (process.platform === "win32") return;

    const holder = await newRoot();
    const rootLink = path.join(holder, "root-link");
    await symlink(path.parse(holder).root, rootLink, "dir");
    const manager = new ModelAssetManager({
      rootDir: rootLink,
      maxArtifactBytes: 1024
    });
    const payload = Buffer.from("root-link");
    const manifest = manifestFor(payload, "https://example.test/root-link.bin");

    await expect(manager.inspect(manifest)).rejects.toMatchObject({
      code: "INVALID_CACHE_ROOT"
    });
  });

  it("rejects replacement of the artifacts parent by another directory", async () => {
    const payload = Buffer.from("artifacts-parent-replacement");
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/artifacts-parent.bin");
    await manager.inspect(manifest);

    const original = path.join(root, "artifacts");
    const moved = path.join(root, "artifacts-original");
    await rename(original, moved);
    await mkdir(original);
    const sentinel = path.join(original, "sentinel.txt");
    await writeFile(sentinel, "replacement");

    await expect(manager.inspect(manifest)).rejects.toMatchObject({
      code: "INVALID_CACHE_ROOT"
    });
    expect(await readFile(sentinel, "utf8")).toBe("replacement");
  });

  it("rejects replacement of the temporary parent by another directory", async () => {
    const payload = Buffer.from("tmp-parent-replacement");
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/tmp-parent.bin");
    await manager.inspect(manifest);

    const original = path.join(root, "tmp");
    const moved = path.join(root, "tmp-original");
    await rename(original, moved);
    await mkdir(original);
    const sentinel = path.join(original, "sentinel.txt");
    await writeFile(sentinel, "replacement");

    await expect(manager.cleanupTemporary()).rejects.toMatchObject({
      code: "INVALID_CACHE_ROOT"
    });
    expect(await readFile(sentinel, "utf8")).toBe("replacement");
  });

  it("refuses removal if the artifacts parent is replaced by a symlink", async () => {
    if (process.platform === "win32") return;

    const payload = Buffer.from("parent-symlink");
    const root = await newRoot();
    const outside = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/parent-symlink.bin");
    await manager.inspect(manifest);

    const outsideInstallation = path.join(outside, artifactInstallationKey(manifest));
    await mkdir(outsideInstallation);
    const sentinel = path.join(outsideInstallation, "sentinel.txt");
    await writeFile(sentinel, "keep-me");
    await rm(path.join(root, "artifacts"), { recursive: true, force: true });
    await symlink(outside, path.join(root, "artifacts"), "dir");

    await expect(manager.remove(manifest)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readFile(sentinel, "utf8")).toBe("keep-me");
  });

  it("refuses temporary cleanup if the tmp parent is replaced by a symlink", async () => {
    if (process.platform === "win32") return;

    const payload = Buffer.from("tmp-parent-symlink");
    const root = await newRoot();
    const outside = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/tmp-parent-symlink.bin");
    await manager.inspect(manifest);

    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "keep-me");
    await rm(path.join(root, "tmp"), { recursive: true, force: true });
    await symlink(outside, path.join(root, "tmp"), "dir");

    await expect(manager.cleanupTemporary()).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readFile(sentinel, "utf8")).toBe("keep-me");
  });

  it("refuses to recursively delete unexpected nested cache content", async () => {
    const payload = Buffer.from("nested-cache");
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/nested-cache.bin");
    await manager.inspect(manifest);

    const installation = path.join(root, "artifacts", artifactInstallationKey(manifest));
    const nested = path.join(installation, "unexpected");
    await mkdir(nested, { recursive: true });
    const sentinel = path.join(nested, "sentinel.txt");
    await writeFile(sentinel, "keep-me");

    await expect(manager.remove(manifest)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readFile(sentinel, "utf8")).toBe("keep-me");
  });

  it("rejects replacement of the canonical cache root after initialization", async () => {
    if (process.platform === "win32") return;

    const payload = Buffer.from("root-replacement");
    const root = await newRoot();
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/root-replacement.bin");
    await manager.inspect(manifest);

    const movedRoot = root + "-moved";
    roots.push(movedRoot);
    await rename(root, movedRoot);
    await mkdir(root);

    await expect(manager.inspect(manifest)).rejects.toMatchObject({
      code: "INVALID_CACHE_ROOT"
    });
  });

  it("never trusts a symlinked installed payload", async () => {
    if (process.platform === "win32") return;

    const payload = Buffer.from("payload-symlink");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    const alternate = path.join(sourceRoot, "alternate.bin");
    await writeFile(source, payload);
    await writeFile(alternate, payload);

    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/payload-symlink.bin");
    const installed = await manager.importLocal(manifest, source);
    await rm(installed);
    await symlink(alternate, installed, "file");

    expect(await manager.inspect(manifest)).toMatchObject({
      status: "CORRUPT",
      errorCode: "UNSAFE_PATH"
    });
    await expect(manager.getInstalledPath(manifest)).rejects.toMatchObject({
      code: "NOT_INSTALLED"
    });
  });

  it("never trusts a symlinked cached manifest", async () => {
    if (process.platform === "win32") return;

    const payload = Buffer.from("manifest-symlink");
    const root = await newRoot();
    const sourceRoot = await newRoot();
    const source = path.join(sourceRoot, "source.bin");
    await writeFile(source, payload);

    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/manifest-symlink.bin");
    await manager.importLocal(manifest, source);

    const installation = path.join(root, "artifacts", artifactInstallationKey(manifest));
    const manifestPath = path.join(installation, "manifest.json");
    const outsideManifest = path.join(sourceRoot, "manifest.json");
    await writeFile(outsideManifest, serializeAssetManifest(manifest));
    await rm(manifestPath);
    await symlink(outsideManifest, manifestPath, "file");

    expect(await manager.inspect(manifest)).toMatchObject({
      status: "CORRUPT",
      errorCode: "CORRUPT_INSTALLATION"
    });
  });

  it("does not follow a hostile symlink while removing a cache entry", async () => {
    if (process.platform === "win32") return;

    const payload = Buffer.from("symlink-safe");
    const root = await newRoot();
    const outside = await newRoot();
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "keep-me");
    const manager = managerFor(root);
    const manifest = manifestFor(payload, "https://example.test/symlink.bin");
    await manager.inspect(manifest);

    const installation = path.join(root, "artifacts", artifactInstallationKey(manifest));
    await symlink(outside, installation, "dir");
    expect((await manager.inspect(manifest)).status).toBe("CORRUPT");
    await manager.remove(manifest);

    expect(await readFile(sentinel, "utf8")).toBe("keep-me");
    expect(await readdir(path.join(root, "artifacts"))).toEqual([]);
  });
});

function managerFor(
  rootDir: string,
  overrides: Partial<ConstructorParameters<typeof ModelAssetManager>[0]> = {}
): ModelAssetManager {
  return new ModelAssetManager({
    rootDir,
    maxArtifactBytes: 1024 * 1024,
    downloadTimeoutMs: 2_000,
    maxRedirects: 3,
    ...overrides
  });
}

function managedArtifactBytes(manifest: AssetManifest): number {
  return manifest.sizeBytes + Buffer.byteLength(serializeAssetManifest(manifest), "utf8");
}

function sha256(payload: Buffer): AssetManifest["sha256"] {
  return createHash("sha256").update(payload).digest("hex");
}

function manifestFor(
  payload: Buffer,
  sourceUrl: string,
  overrides: Partial<AssetManifest> = {}
): AssetManifest {
  return AssetManifestSchema.parse({
    schemaVersion: 1,
    familyId: "fixture",
    artifactId: "artifact",
    version: "1.0.0",
    type: "MODEL",
    platform: "linux",
    architecture: "x64",
    filename: "artifact.bin",
    sizeBytes: payload.byteLength,
    sha256: sha256(payload),
    sourceUrl,
    ...overrides
  });
}

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "interview-model-assets-"));
  roots.push(root);
  return root;
}

async function startFixtureServer(handler: FixtureHandler): Promise<FixtureServer> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    void Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not expose a TCP address.");
  }
  return {
    server,
    baseUrl: "http://127.0.0.1:" + String(address.port),
    requestCount: () => requests
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (resolvePromise === undefined) throw new Error("Deferred promise is not initialized.");
      resolvePromise(value);
    }
  };
}

async function eventually(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Condition was not satisfied before test timeout.");
}
