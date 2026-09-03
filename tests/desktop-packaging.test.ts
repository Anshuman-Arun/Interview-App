import { createHash } from "node:crypto";
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

    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    expect(packageJson.productName).toBe("Interview App");
    expect(packageJson.main).toBe("dist/desktop-runtime/apps/desktop/src/main.js");
    expect(packageJson.scripts?.["package:win"]).toContain("node scripts/clean-windows-package.mjs");
    expect(packageJson.scripts?.["package:win"]).toContain("npx --yes electron-builder@26.15.3");
    expect(packageJson.scripts?.["dist:win"]).toContain("node scripts/clean-windows-package.mjs");
    expect(packageJson.scripts?.["dist:win"]).toContain("npx --yes electron-builder@26.15.3 --win nsis --x64");
    expect(packageJson.scripts?.["package:win"]).toContain("--publish never");
    expect(packageJson.scripts?.["dist:win"]).toContain("--publish never");
    expect(config).toContain("appId: com.anshuman.interviewapp");
    expect(config).toContain("artifactName: InterviewApp-Setup-${version}.${ext}");
    expect(config).toContain("asar: true");
    expect(config).toContain('"!**/*.map"');
    expect(config).toContain("deleteAppDataOnUninstall: false");
    expect(config).toContain("runAfterFinish: false");
  });

  it("copies only reviewed production worker resources to the exact packaged worker boundary", async () => {
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


  it("pins packaged Python resource hashes to the reviewed source bytes", async () => {
    const integrity = await source("apps/desktop/src/runtime/packaged-resource-integrity.ts");
    const worker = await readFile(path.join(root, "workers/python/local_model_worker.py"));
    const preload = await readFile(path.join(root, "apps/desktop/preload.cjs"));
    const requirements = await readFile(
      path.join(root, "workers/python/requirements-local-model-runtime.txt")
    );
    const workerHash = createHash("sha256").update(worker).digest("hex");
    const preloadHash = createHash("sha256").update(preload).digest("hex");
    const requirementsHash = createHash("sha256").update(requirements).digest("hex");

    expect(integrity).toContain(workerHash);
    expect(integrity).toContain(preloadHash);
    expect(integrity).toContain(requirementsHash);
    const attributes = await source(".gitattributes");
    expect(attributes).toContain("workers/python/*.py text eol=lf");
    expect(attributes).toContain("apps/desktop/preload.cjs text eol=lf");
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

  it("keeps installer CI scoped, explicitly unsigned, and independent of mock inference", async () => {
    const workflow = await source(".github/workflows/windows-installer.yml");
    const generalCi = await source(".github/workflows/ci.yml");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain('"apps/desktop/**"');
    expect(workflow).toContain('"tests/desktop-packaging.test.ts"');
    expect(workflow).toContain("group: windows-installer-${{ github.sha }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain('"NotSigned"');
    expect(workflow).not.toContain("INTERVIEW_CI_PROVIDER_MODE");
    expect(generalCi).not.toContain("package Windows installer");
  });

  it("provides artifact, process-lifecycle, installer and release-hygiene gates", async () => {
    const checker = await source("scripts/check-packaged-desktop.mjs");
    const smoke = await source("scripts/run-packaged-desktop-smoke.ps1");
    const installer = await source("scripts/test-windows-installer.ps1");

    expect(checker).toContain("local_model_worker.py");
    expect(checker).toContain("@electron/asar@4.3.0");
    expect(checker).toContain("prohibited app.asar entries");
    expect(checker).toContain("renderer resource tree differs from the reviewed Vite build");
    expect(checker).toContain("renderer files matched byte-for-byte");
    expect(smoke).toContain("--packaged-smoke-test");
    expect(smoke).toContain("--packaged-single-instance-smoke-host");
    expect(installer).toContain("preserve-across-upgrade-and-uninstall");
    expect(installer).toContain("Uninstall*.exe");
  });
});
