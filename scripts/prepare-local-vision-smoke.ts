import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ModelAssetManager } from "../packages/model-assets/src/index.js";
import { VISION_ASSETS } from "../apps/desktop/src/runtime/model-assets.js";

const [cacheRootArg, outputRootArg] = process.argv.slice(2);
if (
  typeof cacheRootArg !== "string"
  || typeof outputRootArg !== "string"
  || !path.isAbsolute(cacheRootArg)
  || !path.isAbsolute(outputRootArg)
) {
  throw new Error(
    "Usage: tsx scripts/prepare-local-vision-smoke.ts <absolute-cache-root> <absolute-output-root>"
  );
}

const manager = new ModelAssetManager({
  rootDir: cacheRootArg,
  maxArtifactBytes: 128 * 1024 * 1024,
  maxCacheBytes: 512 * 1024 * 1024,
  downloadTimeoutMs: 120_000,
  maxRedirects: 3,
  allowCrossOriginRedirects: true,
  maxListEntries: 256
});

await manager.cleanupTemporary();
await mkdir(outputRootArg, { recursive: true });

let installedBytes = 0;
for (const asset of VISION_ASSETS) {
  await manager.install(asset.manifest);
  if (!await manager.verifyInstalledArtifact(asset.manifest)) {
    throw new Error(`Vision smoke asset failed post-install verification: ${asset.manifest.artifactId}`);
  }
  const source = await manager.getInstalledPath(asset.manifest);
  const destination = path.join(outputRootArg, asset.manifest.filename);
  await copyFile(source, destination);
  installedBytes += asset.manifest.sizeBytes;
}

const installed = await manager.listInstalledArtifacts();
const visionInstalled = installed.filter((asset) => asset.familyId === "rapid-latex-ocr");
if (visionInstalled.length !== VISION_ASSETS.length) {
  throw new Error("Vision smoke cache did not contain the complete pinned model set");
}

process.stdout.write(
  JSON.stringify({
    modelRoot: outputRootArg,
    installedBytes,
    artifactCount: visionInstalled.length,
    sha256: visionInstalled.map((asset) => asset.sha256).sort()
  }) + "\n"
);
