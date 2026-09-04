import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const repoRoot = process.cwd();

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "interview-release-"));
  roots.push(root);
  return root;
}

function runNode(script: string, args: readonly string[]) {
  return spawnSync(process.execPath, [path.join(repoRoot, script), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("versioned Windows release publishing", () => {
  it("accepts only a stable tag that exactly matches the canonical package version", async () => {
    const root = await tempRoot();
    const packagePath = path.join(root, "package.json");
    await writeFile(packagePath, JSON.stringify({ version: "0.1.0" }), "utf8");

    const valid = runNode("scripts/check-release-version.mjs", [
      "--tag", "v0.1.0",
      "--package", packagePath
    ]);
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain("v0.1.0 = 0.1.0");

    for (const tag of [
      "0.1.0",
      "v0.1",
      "v01.1.0",
      "v0.01.0",
      "v0.1.00",
      "v0.1.0-beta.1",
      "v0.1.0.0",
      " v0.1.0",
      "v0.1.0 ",
      "v+0.1.0",
      "v0.-1.0"
    ]) {
      const invalid = runNode("scripts/check-release-version.mjs", [
        "--tag", tag,
        "--package", packagePath
      ]);
      expect(invalid.status, tag).not.toBe(0);
    }

    const mismatch = runNode("scripts/check-release-version.mjs", [
      "--tag", "v0.1.1",
      "--package", packagePath
    ]);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("does not match canonical package version");

    for (const version of ["01.1.0", "0.01.0", "0.1.00", "0.1.0-beta.1", " 0.1.0"]) {
      await writeFile(packagePath, JSON.stringify({ version }), "utf8");
      const invalidPackage = runNode("scripts/check-release-version.mjs", [
        "--tag", "v0.1.0",
        "--package", packagePath
      ]);
      expect(invalidPackage.status, version).not.toBe(0);
      expect(invalidPackage.stderr).toContain("Canonical package version");
    }
  });

  it("writes and verifies the checksum for the exact release bytes", async () => {
    const root = await tempRoot();
    const installer = path.join(root, "InterviewApp-Setup-0.1.0.exe");
    const checksum = `${installer}.sha256`;
    const bytes = Buffer.from("deterministic release bytes", "utf8");
    await writeFile(installer, bytes);

    const generated = runNode("scripts/create-release-checksum.mjs", [
      "--file", installer,
      "--output", checksum
    ]);
    expect(generated.status).toBe(0);

    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(await readFile(checksum, "utf8"))
      .toBe(`${digest}  InterviewApp-Setup-0.1.0.exe\n`);

    const verified = runNode("scripts/create-release-checksum.mjs", [
      "--file", installer,
      "--verify", checksum
    ]);
    expect(verified.status).toBe(0);

    await writeFile(installer, Buffer.from("tampered", "utf8"));
    const tampered = runNode("scripts/create-release-checksum.mjs", [
      "--file", installer,
      "--verify", checksum
    ]);
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain("Checksum does not match release artifact");

    await writeFile(installer, bytes);
    const malformedChecksums = [
      `${digest.toUpperCase()}  InterviewApp-Setup-0.1.0.exe\n`,
      `${digest} InterviewApp-Setup-0.1.0.exe\n`,
      `${digest}   InterviewApp-Setup-0.1.0.exe\n`,
      `${digest}  InterviewApp-Setup-0.1.1.exe\n`,
      `${digest}  ../InterviewApp-Setup-0.1.0.exe\n`,
      `${digest}  InterviewApp-Setup-0.1.0.exe\nextra\n`
    ];
    for (const malformed of malformedChecksums) {
      await writeFile(checksum, malformed, "utf8");
      const rejected = runNode("scripts/create-release-checksum.mjs", [
        "--file", installer,
        "--verify", checksum
      ]);
      expect(rejected.status, malformed).not.toBe(0);
    }
  });

  it("pins the release workflow to the immutable tag event and publishes only after gates", async () => {
    const workflow = (
      await readFile(
        path.join(repoRoot, ".github/workflows/windows-release.yml"),
        "utf8"
      )
    ).replace(/\r\n/gu, "\n");

    expect(workflow).toContain('tags:\n      - "v*.*.*"');
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain('git rev-parse "$($env:GITHUB_SHA)^{commit}"');
    expect(workflow).toContain('git rev-parse "$($env:RELEASE_TAG)^{commit}"');
    expect(workflow).toContain('git merge-base --is-ancestor "$eventCommit" "refs/remotes/origin/main"');
    expect(workflow).toContain("Tagged release commit $eventCommit is not reachable from authoritative main");
    expect(workflow).toContain("Release tag moved during validation");
    expect(workflow).toContain("Release notes still contain an unresolved template placeholder");
    expect(workflow).toContain("node scripts/check-release-version.mjs");
    expect(workflow).toContain("pnpm check");
    expect(workflow).toContain("pnpm dist:win");
    expect(workflow).toContain("run-packaged-desktop-smoke.ps1");
    expect(workflow).toContain("test-windows-installer.ps1");
    expect(workflow).toContain("create-release-checksum.mjs");
    expect(workflow).toContain("--draft");
    expect(workflow).toContain("contents: write");

    const buildIndex = workflow.indexOf("Build exact release installer");
    const smokeIndex = workflow.indexOf("Run packaged executable smoke");
    const checksumIndex = workflow.indexOf("Generate and verify SHA-256");
    const finalTagProofIndex = workflow.indexOf("Release tag moved during validation");
    const releaseIndex = workflow.indexOf("Create draft GitHub Release");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(buildIndex);
    expect(checksumIndex).toBeGreaterThan(smokeIndex);
    expect(finalTagProofIndex).toBeGreaterThan(checksumIndex);
    expect(releaseIndex).toBeGreaterThan(checksumIndex);
  });

  it("uses one canonical version for packaging and exposes packaged/development identity", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8")
    ) as { version?: string };
    const builder = await readFile(path.join(repoRoot, "electron-builder.yml"), "utf8");
    const main = await readFile(path.join(repoRoot, "apps/desktop/src/main.ts"), "utf8");
    const settings = await readFile(path.join(repoRoot, "apps/web/src/pages/SettingsPage.tsx"), "utf8");

    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(builder).toContain("artifactName: InterviewApp-Setup-${version}.${ext}");
    expect(main).toContain('app.isPackaged ? app.getVersion() : "development"');
    expect(settings).toContain("desktopAppVersion");
    expect(settings).toContain("Interview App");
    expect(settings.indexOf("<p>Interview App {desktopAppVersion}</p>"))
      .toBeLessThan(settings.indexOf("{desktopRuntime !== undefined && ("));
    expect(settings).toContain("try {");
    expect(settings).toContain("const bootstrap = bridge.getBootstrap();");
    expect(settings).toContain("catch {");
  });
});
