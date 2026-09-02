import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SupervisedProcessRunner
} from "../packages/local-runtime/src/index.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/supervised-process-worker.mjs", import.meta.url)
);
const temporaryRoots: string[] = [];
const fixturePids: number[] = [];

afterEach(() => {
  for (const pid of fixturePids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runner(
  fixedArgs: readonly string[] = []
): SupervisedProcessRunner {
  return new SupervisedProcessRunner([{
    id: "fixture",
    executable: process.execPath,
    fixedArgs,
    isolatedWorkingDirectory: true
  }]);
}

function request(
  args: readonly string[],
  overrides: Partial<Parameters<SupervisedProcessRunner["execute"]>[0]> = {}
): Parameters<SupervisedProcessRunner["execute"]>[0] {
  return {
    executableId: "fixture",
    args,
    stdin: "hello",
    timeoutMs: 1_000,
    maxStdoutBytes: 16 * 1024,
    maxStderrBytes: 16 * 1024,
    ...overrides
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture pid file was not created");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("supervised one-shot process execution", () => {
  it("passes bounded stdin literally and returns bounded UTF-8 stdout", async () => {
    const runtime = runner();
    const result = await runtime.execute(request([FIXTURE, "echo"], {
      stdin: "literal ; $(not-a-shell) & payload"
    }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("literal ; $(not-a-shell) & payload");
    expect(result.stderrBytes).toBe(0);
  });

  it("round-trips hostile argument boundaries without shell or quoting reinterpretation", async () => {
    const runtime = runner();
    const argumentsToRoundTrip = [
      "",
      "plain",
      "contains spaces",
      'embedded"quote',
      "trailing\\",
      'slashes\\\\before"quote',
      "& | ; $(not-a-shell)",
      '{"type":"object","properties":{"x":{"type":"string"}}}'
    ];
    const result = await runtime.execute(request([
      FIXTURE,
      "echo-args",
      ...argumentsToRoundTrip
    ]));
    expect(JSON.parse(result.stdout)).toEqual(argumentsToRoundTrip);
  });

  it("fails closed for missing, symlinked, accessor-backed, and malformed executable requests", async () => {
    const missing = new SupervisedProcessRunner([{
      id: "missing",
      executable: join(tmpdir(), "definitely-missing-supervised-provider")
    }]);
    await expect(missing.execute(request([], {
      executableId: "missing"
    }))).rejects.toMatchObject({ code: "EXECUTABLE_UNAVAILABLE" });

    let definitionGetterCalls = 0;
    const hostileDefinition = Object.defineProperty({
      id: "hostile",
      executable: process.execPath
    }, "fixedArgs", {
      enumerable: true,
      get() {
        definitionGetterCalls += 1;
        return [];
      }
    });
    expect(() => new SupervisedProcessRunner([
      hostileDefinition as {
        readonly id: string;
        readonly executable: string;
        readonly fixedArgs?: readonly string[];
      }
    ])).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
    expect(definitionGetterCalls).toBe(0);

    const runtime = runner();
    let requestGetterCalls = 0;
    const hostileRequest = Object.defineProperty({
      executableId: "fixture",
      args: [FIXTURE, "echo"],
      stdin: "hello",
      timeoutMs: 1_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024
    }, "onProcessStart", {
      enumerable: true,
      get() {
        requestGetterCalls += 1;
        return () => undefined;
      }
    });
    await expect(runtime.execute(
      hostileRequest as Parameters<SupervisedProcessRunner["execute"]>[0]
    )).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(requestGetterCalls).toBe(0);

    await expect(runtime.execute(request(["bad\0argument"])))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked executable instead of following path indirection",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "supervised-symlink-"));
      temporaryRoots.push(root);
      const linked = join(root, "node-link");
      symlinkSync(process.execPath, linked);
      const runtime = new SupervisedProcessRunner([{
        id: "linked",
        executable: linked
      }]);

      await expect(runtime.execute(request([FIXTURE, "echo"], {
        executableId: "linked"
      }))).rejects.toMatchObject({ code: "EXECUTABLE_UNSAFE" });
    }
  );

  it.runIf(process.platform === "win32")(
    "rejects a hard-linked provider executable identity",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "supervised-hardlink-"));
      temporaryRoots.push(root);
      const original = join(root, "original.exe");
      const linked = join(root, "linked.exe");
      copyFileSync(process.execPath, original);
      linkSync(original, linked);

      const runtime = new SupervisedProcessRunner([{
        id: "hardlinked",
        executable: linked
      }]);
      await expect(runtime.execute(request([FIXTURE, "echo"], {
        executableId: "hardlinked"
      }))).rejects.toMatchObject({ code: "EXECUTABLE_UNSAFE" });
    }
  );

  it("creates a fresh isolated home and working directory for every execution", async () => {
    const runtime = new SupervisedProcessRunner([{
      id: "fixture",
      executable: process.execPath,
      isolatedWorkingDirectory: true,
      isolatedHomeFiles: {
        ".fixture/settings.txt": "application-owned-settings"
      }
    }]);

    const first = await runtime.execute(request([
      FIXTURE,
      "inspect-isolation",
      ".fixture/settings.txt"
    ]));
    const second = await runtime.execute(request([
      FIXTURE,
      "inspect-isolation",
      ".fixture/settings.txt"
    ]));

    const firstPayload = JSON.parse(first.stdout) as {
      readonly home: string;
      readonly cwd: string;
      readonly temp: string;
      readonly configuredContent: string;
      readonly mutationExisted: boolean;
      readonly supervisorVariablesExisted: boolean;
      readonly powershellModulePathExisted: boolean;
    };
    const secondPayload = JSON.parse(second.stdout) as typeof firstPayload;

    expect(firstPayload.configuredContent).toBe("application-owned-settings");
    expect(secondPayload.configuredContent).toBe("application-owned-settings");
    expect(firstPayload.mutationExisted).toBe(false);
    expect(secondPayload.mutationExisted).toBe(false);
    expect(firstPayload.home).not.toBe(secondPayload.home);
    expect(firstPayload.cwd).not.toBe(secondPayload.cwd);
    expect(firstPayload.temp).toContain(firstPayload.home);
    expect(secondPayload.temp).toContain(secondPayload.home);
    expect(firstPayload.temp).not.toBe(secondPayload.temp);
    expect(firstPayload.supervisorVariablesExisted).toBe(false);
    expect(secondPayload.supervisorVariablesExisted).toBe(false);
    if (process.platform === "win32") {
      expect(firstPayload.powershellModulePathExisted).toBe(false);
      expect(secondPayload.powershellModulePathExisted).toBe(false);
    }
    expect(existsSync(firstPayload.home)).toBe(false);
    expect(existsSync(secondPayload.home)).toBe(false);
    expect(existsSync(firstPayload.cwd)).toBe(false);
    expect(existsSync(secondPayload.cwd)).toBe(false);
  });

  it("rejects hostile isolated-home definitions without invoking accessors", () => {
    let getterCalls = 0;
    const hostileFiles = Object.defineProperty({}, ".fixture/settings.txt", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      }
    });

    expect(() => new SupervisedProcessRunner([{
      id: "fixture",
      executable: process.execPath,
      isolatedHomeFiles: hostileFiles
    }])).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
    expect(getterCalls).toBe(0);
  });

  it("rejects isolated-home traversal and Windows device-name path tricks", () => {
    for (const relativePath of [
      "../outside.txt",
      "C:/outside.txt",
      "CON/settings.txt",
      "nested/COM1",
      "nested\\outside.txt",
      "trailing./settings.txt"
    ]) {
      expect(() => new SupervisedProcessRunner([{
        id: "fixture",
        executable: process.execPath,
        isolatedHomeFiles: {
          [relativePath]: "must-not-be-written"
        }
      }])).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
    }
  });

  it("recovers when a missing executable later appears, then pins its identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "supervised-recovery-"));
    temporaryRoots.push(root);
    const executable = join(root, process.platform === "win32" ? "node.exe" : "node");
    const runtime = new SupervisedProcessRunner([{
      id: "recoverable",
      executable
    }]);

    await expect(runtime.execute(request([FIXTURE, "echo"], {
      executableId: "recoverable"
    }))).rejects.toMatchObject({ code: "EXECUTABLE_UNAVAILABLE" });

    copyFileSync(process.execPath, executable);
    if (process.platform !== "win32") chmodSync(executable, 0o755);

    await expect(runtime.execute(request([FIXTURE, "echo"], {
      executableId: "recoverable",
      stdin: "available-now"
    }))).resolves.toMatchObject({
      exitCode: 0,
      stdout: "available-now"
    });

    const replacement = join(
      root,
      process.platform === "win32" ? "replacement.exe" : "replacement"
    );
    copyFileSync(process.execPath, replacement);
    if (process.platform !== "win32") chmodSync(replacement, 0o755);
    rmSync(executable, { force: true });
    renameSync(replacement, executable);

    await expect(runtime.execute(request([FIXTURE, "echo"], {
      executableId: "recoverable"
    }))).rejects.toMatchObject({ code: "EXECUTABLE_UNSAFE" });
  });

  it("does not start a process for an already-cancelled request", async () => {
    const runtime = runner();
    const controller = new AbortController();
    controller.abort();
    let started = false;

    await expect(runtime.execute(request([FIXTURE, "echo"], {
      signal: controller.signal,
      onProcessStart: () => {
        started = true;
      }
    }))).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });
    expect(started).toBe(false);
  });

  it("kills hung executions on timeout and explicit cancellation", async () => {
    const runtime = runner();

    await expect(runtime.execute(request([FIXTURE, "hang"], {
      timeoutMs: 80
    }))).rejects.toMatchObject({ code: "EXECUTION_TIMEOUT" });

    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const execution = runtime.execute(request([FIXTURE, "hang"], {
      signal: controller.signal,
      onProcessStart: () => {
        markStarted?.();
      }
    }));
    await started;
    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });
  });

  it("drains active executions, blocks launches during drain, and permits reuse after cleanup", async () => {
    const runtime = runner();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const execution = runtime.execute(request([FIXTURE, "hang"], {
      timeoutMs: 2_000,
      onProcessStart: () => {
        markStarted?.();
      }
    }));
    await started;

    const firstDrain = runtime.drain();
    const secondDrain = runtime.drain();
    expect(secondDrain).toBe(firstDrain);

    await expect(runtime.execute(request([FIXTURE, "echo"], {
      stdin: "must-not-start-during-drain"
    }))).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });

    await expect(execution).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });
    await expect(firstDrain).resolves.toBeUndefined();

    await expect(runtime.execute(request([FIXTURE, "echo"], {
      stdin: "after-clean-drain"
    }))).resolves.toMatchObject({
      exitCode: 0,
      stdout: "after-clean-drain"
    });
  });

  it("bounds stdout and stderr without reflecting hostile stream content in errors", async () => {
    const runtime = runner();

    let stdoutError: unknown;
    try {
      await runtime.execute(request([FIXTURE, "huge-stdout", "100000"], {
        maxStdoutBytes: 512
      }));
    } catch (error) {
      stdoutError = error;
    }
    expect(stdoutError).toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
    expect(String(stdoutError)).not.toContain("xxxxx");

    let stderrError: unknown;
    try {
      await runtime.execute(request([FIXTURE, "huge-stderr", "100000"], {
        maxStderrBytes: 512
      }));
    } catch (error) {
      stderrError = error;
    }
    expect(stderrError).toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
    expect(String(stderrError)).not.toContain("eeee");
  });

  it.each(["stdout", "stderr"] as const)(
    "terminates a process that writes %s forever when its byte budget is crossed",
    async (stream) => {
      const runtime = runner();
      await expect(runtime.execute(request([
        FIXTURE,
        "write-forever",
        stream
      ], {
        timeoutMs: 2_000,
        maxStdoutBytes: 16 * 1024,
        maxStderrBytes: 16 * 1024
      }))).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
    }
  );

  it("rejects malformed UTF-8 stdout", async () => {
    const runtime = runner();
    await expect(runtime.execute(request([FIXTURE, "invalid-utf8"])))
      .rejects.toMatchObject({ code: "INVALID_STDOUT_UTF8" });
  });

  it("kills a nested child tree when the parent ignores termination", async () => {
    const root = mkdtempSync(join(tmpdir(), "supervised-tree-"));
    temporaryRoots.push(root);
    const pidFile = join(root, "child.pid");
    const runtime = runner();
    const controller = new AbortController();

    const execution = runtime.execute(request([FIXTURE, "tree-hang", pidFile], {
      signal: controller.signal,
      timeoutMs: 2_000
    }));
    await waitForFile(pidFile);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    fixturePids.push(childPid);
    expect(isProcessAlive(childPid)).toBe(true);

    controller.abort();
    await expect(execution).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && isProcessAlive(childPid)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    expect(isProcessAlive(childPid)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "cleans a residual POSIX process group when the root exits first",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "supervised-residual-tree-"));
      temporaryRoots.push(root);
      const pidFile = join(root, "child.pid");
      const runtime = runner();

      await expect(runtime.execute(request([FIXTURE, "exit-with-tree", pidFile])))
        .resolves.toMatchObject({ exitCode: 0 });
      const childPid = Number(readFileSync(pidFile, "utf8"));
      fixturePids.push(childPid);

      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline && isProcessAlive(childPid)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      expect(isProcessAlive(childPid)).toBe(false);
    }
  );

  it.runIf(process.platform === "win32")(
    "kills residual descendants when the provider root exits first",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "supervised-windows-residual-tree-"));
      temporaryRoots.push(root);
      const pidFile = join(root, "child.pid");
      const runtime = runner();

      await expect(runtime.execute(request([
        FIXTURE,
        "exit-with-tree",
        pidFile
      ], {
        timeoutMs: 2_000
      }))).resolves.toMatchObject({
        exitCode: 0
      });
      await waitForFile(pidFile);
      const childPid = Number(readFileSync(pidFile, "utf8"));
      fixturePids.push(childPid);

      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline && isProcessAlive(childPid)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      expect(isProcessAlive(childPid)).toBe(false);
    }
  );

  it.runIf(process.platform === "win32")(
    "contains a detached Windows descendant after the provider root exits",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "supervised-windows-detached-tree-"));
      temporaryRoots.push(root);
      const pidFile = join(root, "child.pid");
      const runtime = runner();

      await expect(runtime.execute(request([
        FIXTURE,
        "exit-with-detached-tree",
        pidFile
      ], {
        timeoutMs: 2_000
      }))).resolves.toMatchObject({ exitCode: 0 });
      await waitForFile(pidFile);
      const childPid = Number(readFileSync(pidFile, "utf8"));
      fixturePids.push(childPid);

      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline && isProcessAlive(childPid)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      expect(isProcessAlive(childPid)).toBe(false);
    }
  );

  it.runIf(process.platform === "win32")(
    "rejects provider arguments that exceed the bounded Windows command line",
    async () => {
      const runtime = runner();
      let started = false;
      await expect(runtime.execute(request([
        FIXTURE,
        "echo",
        "x".repeat(20_000)
      ], {
        onProcessStart: () => {
          started = true;
        }
      }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(started).toBe(false);
    }
  );

  it("recovers after a crash and supports simultaneous isolated executions", async () => {
    const runtime = runner();

    const crashed = await runtime.execute(request([FIXTURE, "crash"]));
    expect(crashed.exitCode).toBe(7);
    expect(crashed.stdout).toBe("SENSITIVE_STDOUT_SENTINEL");
    expect(crashed.stderrBytes).toBeGreaterThan(0);

    await expect(runtime.execute(request([FIXTURE, "echo"], { stdin: "after-crash" })))
      .resolves.toMatchObject({ exitCode: 0, stdout: "after-crash" });

    const [first, second] = await Promise.all([
      runtime.execute(request([FIXTURE, "echo"], { stdin: "session-a" })),
      runtime.execute(request([FIXTURE, "echo"], { stdin: "session-b" }))
    ]);
    expect([first.stdout, second.stdout].sort()).toEqual(["session-a", "session-b"]);
  });
});
