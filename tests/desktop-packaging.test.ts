import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("Windows desktop packaging contract", () => {
  it("pins mature packaging tooling and deterministic Windows artifact identity", async () => {
    const packageJson = JSON.parse(await source("package.json")) as {
      version?: string;
      productName?: string;
      main?: string;
      scripts?: Record<string, string>;
    };
    const config = await source("electron-builder.yml");

    expect(packageJson.version).toBe("0.1.0");
    expect(packageJson.productName).toBe("Interview App");
    expect(packageJson.main).toBe("dist/desktop-runtime/apps/desktop/src/main.js");
    expect(packageJson.scripts?.["package:win"]).toContain("electron-builder@26.15.3");
    expect(packageJson.scripts?.["dist:win"]).toContain("--win nsis --x64");
    expect(config).toContain("appId: com.anshuman.interviewapp");
    expect(config).toContain("artifactName: InterviewApp-Setup-${version}.${ext}");
    expect(config).toContain("asar: true");
    expect(config).toContain("deleteAppDataOnUninstall: false");
    expect(config).toContain("runAfterFinish: false");
  });

  it("copies only reviewed production worker resources to Ivy's exact packaged boundary", async () => {
    const config = await source("electron-builder.yml");
    expect(config).toContain("to: workers/python/local_model_worker.py");
    expect(config).toContain("to: workers/python/requirements-local-model-runtime.txt");
    expect(config).not.toContain("test_fixture_worker.py");
    expect(config).not.toContain("tests/fixtures");
    expect(config).not.toContain(".env");
    expect(config).not.toContain(".sqlite");
  });

  it("keeps mutable state under Electron userData instead of install resources", async () => {
    const config = await source("electron-builder.yml");
    const paths = await source("apps/desktop/src/paths.ts");
    const runtime = await source("apps/desktop/src/runtime/composition.ts");

    expect(config).toContain("from: dist/apps/web");
    expect(config).toContain("to: web");
    expect(config).toContain("from: apps/desktop/preload.cjs");
    expect(paths).toContain('path.join(input.resourcesPath, "web")');
    expect(paths).toContain('path.join(input.resourcesPath, "preload.cjs")');
    expect(paths).toContain('path.join(input.userDataPath, "data")');
    expect(runtime).toContain(
      'path.join(options.resourcesPath, "workers", "python", "local_model_worker.py")'
    );
    expect(runtime).toContain('path.join(options.appDataRoot, "model-assets")');
    expect(runtime).toContain('path.join(options.appDataRoot, "runtime-models")');
  });

  it("keeps model setup behind narrow authenticated preload IPC", async () => {
    const main = await source("apps/desktop/src/main.ts");
    const preload = await source("apps/desktop/preload.cjs");

    expect(main).toContain("isAuthorizedDesktopInvoke(event)");
    expect(main).toContain("runtime.installVoiceAssets(startupAbort.signal)");
    expect(main).toContain("await activeModelInstall.catch(() => undefined)");
    expect(preload).toContain("getLocalRuntimeStatus");
    expect(preload).toContain("installLocalModels");
    expect(preload).not.toMatch(/require\(["'](?:node:)?(?:fs|child_process)["']\)/u);
    expect(preload).not.toContain("process.env");
    expect(preload).not.toContain("shell.");
  });

  it("provides artifact, process-lifecycle, installer and release-hygiene gates", async () => {
    const checker = await source("scripts/check-packaged-desktop.mjs");
    const smoke = await source("scripts/run-packaged-desktop-smoke.ps1");
    const installer = await source("scripts/test-windows-installer.ps1");

    expect(checker).toContain("local_model_worker.py");
    expect(checker).toContain("@electron/asar@4.3.0");
    expect(checker).toContain("prohibited app.asar entries");
    expect(smoke).toContain("--packaged-smoke-test");
    expect(smoke).toContain("--packaged-single-instance-smoke-host");
    expect(installer).toContain("preserve-across-upgrade-and-uninstall");
    expect(installer).toContain("Uninstall*.exe");
  });
});
