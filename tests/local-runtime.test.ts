import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalRuntimeError,
  LocalRuntimeManager,
  type LocalComponentDefinition
} from "../packages/local-runtime/src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/local-runtime-worker.mjs", import.meta.url));
const temporaryRoots: string[] = [];
const managers: LocalRuntimeManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try {
      await manager.stopAll();
    } catch {
      // Cleanup continues so one failed stop does not leak other fixture workers.
    }
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manager(options: ConstructorParameters<typeof LocalRuntimeManager>[0] = {}): LocalRuntimeManager {
  const value = new LocalRuntimeManager(options);
  managers.push(value);
  return value;
}

function definition(
  id: string,
  mode: string,
  overrides: Partial<LocalComponentDefinition> = {},
  extraArgs: readonly string[] = []
): LocalComponentDefinition {
  return {
    id,
    executable: process.execPath,
    args: [FIXTURE, mode, ...extraArgs],
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 150,
    terminationTimeoutMs: 150,
    readiness: {
      kind: "STDOUT_JSON",
      evaluate: (message) => readyDecision(message)
    },
    ...overrides
  };
}

function readyDecision(message: unknown) {
  if (typeof message !== "object" || message === null) return false;
  const value = message as Record<string, unknown>;
  if (value.type !== "READY") return false;
  return {
    ready: true,
    handshake: {
      ...(typeof value.componentVersion === "string" ? { componentVersion: value.componentVersion } : {}),
      ...(typeof value.protocolVersion === "number" ? { protocolVersion: value.protocolVersion } : {}),
      capabilities: Array.isArray(value.capabilities)
        ? value.capabilities.filter((item): item is string => typeof item === "string")
        : []
    }
  };
}

describe("local worker lifecycle manager", () => {
  it("starts one process, coalesces duplicate starts, records readiness, and handshakes versions", async () => {
    const runtime = manager();
    runtime.register(definition("worker", "ready", {
      expectedHandshake: { componentVersion: "fixture-1", protocolVersion: 1 }
    }));

    const first = runtime.start("worker");
    const duplicate = runtime.start("worker");
    expect(duplicate).toBe(first);
    const status = await first;

    expect(status.state).toBe("READY");
    expect(status.pid).toBeTypeOf("number");
    expect(status.readiness.ready).toBe(true);
    expect(status.handshake).toMatchObject({
      componentVersion: "fixture-1",
      protocolVersion: 1,
      capabilities: ["FIXTURE"]
    });
  });

  it("times out readiness and ignores malformed stdout as trusted protocol", async () => {
    const runtime = manager();
    runtime.register(definition("malformed", "malformed-ready", { startupTimeoutMs: 100 }));

    await expect(runtime.start("malformed")).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(runtime.getStatus("malformed").state).toBe("FAILED");
    expect(runtime.getStatus("malformed").stdout.lines.join(" ")).toContain("{not-json");
  });

  it("detects immediate crashes and invalid executables", async () => {
    const runtime = manager();
    runtime.register(definition("crash", "crash"));
    await expect(runtime.start("crash")).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    const crashed = runtime.getStatus("crash");
    expect(crashed.state).toBe("FAILED");
    expect(crashed.lastExit).toMatchObject({ code: 7, previousState: "STARTING", unexpected: true });

    runtime.register({
      id: "missing",
      executable: join(tmpdir(), "definitely-missing-interview-worker"),
      startupTimeoutMs: 100,
      shutdownTimeoutMs: 100,
      readiness: { kind: "STABLE_PROCESS", stableMs: 20 }
    });
    await expect(runtime.start("missing")).rejects.toMatchObject({ code: "SPAWN_FAILED" });
  });

  it("stops gracefully, accepts repeated stop, and stops while starting", async () => {
    const runtime = manager();
    runtime.register(definition("graceful", "stdin-shutdown", {
      gracefulShutdown: (control) => control.writeStdin("shutdown-now\n")
    }));
    await runtime.start("graceful");
    await expect(runtime.stop("graceful")).resolves.toMatchObject({ disposition: "GRACEFUL" });
    await expect(runtime.stop("graceful")).resolves.toMatchObject({ disposition: "ALREADY_STOPPED" });

    runtime.register(definition("slow", "delayed-ready", { startupTimeoutMs: 1_000 }, ["500"]));
    const start = runtime.start("slow");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await runtime.stop("slow");
    await expect(start).rejects.toMatchObject({ code: "START_CANCELLED" });
    expect(runtime.getStatus("slow").state).toBe("STOPPED");
  });

  it("escalates shutdown when a process ignores graceful EOF", async () => {
    const runtime = manager();
    runtime.register(definition("stubborn", "ignore-shutdown", {
      shutdownTimeoutMs: 40,
      terminationTimeoutMs: 80,
      gracefulShutdown: () => undefined
    }));
    await runtime.start("stubborn");
    const result = await runtime.stop("stubborn");

    expect(result.disposition).not.toBe("GRACEFUL");
    if (process.platform === "win32") expect(["TERMINATED", "FORCED"]).toContain(result.disposition);
    else expect(result.disposition).toBe("FORCED");
    expect(runtime.getStatus("stubborn").state).toBe("STOPPED");
  });

  it("stops all components in reverse registration order and waits for termination", async () => {
    const runtime = manager();
    runtime.register(definition("first", "ready"));
    runtime.register(definition("second", "ready"));
    await Promise.all([runtime.start("first"), runtime.start("second")]);

    const results = await runtime.stopAll();
    expect(results.map((result) => result.componentId)).toEqual(["second", "first"]);
    expect(runtime.listStatuses().map((status) => status.state)).toEqual(["STOPPED", "STOPPED"]);
  });

  it("retries startup failures within a bounded budget and can recover", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-runtime-retry-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    runtime.register(definition("retry", "crash-counter", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 2, backoffMs: 10, maxBackoffMs: 20 }
    }, [counter, "1"]));

    const status = await runtime.start("retry");
    expect(status.state).toBe("READY");
    expect(status.restartCount).toBe(1);
    expect(readFileSync(counter, "utf8")).toBe("2");
  });

  it("exhausts limited retries without entering an infinite restart loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-runtime-exhaust-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    runtime.register(definition("exhaust", "always-crash-counter", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 2, backoffMs: 5, maxBackoffMs: 5 }
    }, [counter]));

    await expect(runtime.start("exhaust")).rejects.toBeInstanceOf(LocalRuntimeError);
    expect(runtime.getStatus("exhaust")).toMatchObject({ state: "FAILED", restartCount: 2 });
    expect(readFileSync(counter, "utf8")).toBe("3");
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(readFileSync(counter, "utf8")).toBe("3");
  });

  it("detects post-readiness crashes and spends the same bounded restart budget", async () => {
    const runtime = manager();
    runtime.register(definition("late-crash", "ready-then-crash", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 1, backoffMs: 5 }
    }, ["40"]));
    await runtime.start("late-crash");

    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const current = runtime.getStatus("late-crash");
      if (current.state === "FAILED" && current.restartCount === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        if (runtime.getStatus("late-crash").state === "FAILED") break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const status = runtime.getStatus("late-crash");
    expect(status).toMatchObject({ state: "FAILED", restartCount: 1 });
    expect(status.lastExit?.unexpected).toBe(true);
  });

  it("bounds and sanitizes output while passing only controlled environment values", async () => {
    const secret = "runtime-secret-value-9371";
    const parentEnvironment = {
      PATH: process.env.PATH,
      FORBIDDEN_PARENT: "must-not-cross"
    };
    const runtime = manager({ parentEnvironment });
    let observed: Record<string, unknown> | undefined;
    runtime.register(definition("environment", "output-env", {
      environment: {
        values: { EXPLICIT_PUBLIC: "public-value" },
        secrets: { RUNTIME_ONLY_SECRET: secret }
      },
      output: { maxLines: 4, maxBytes: 2_000, maxLineBytes: 2_000 },
      readiness: {
        kind: "STDOUT_JSON",
        evaluate: (message) => {
          if (typeof message === "object" && message !== null && (message as Record<string, unknown>).type === "READY") {
            observed = message as Record<string, unknown>;
            return readyDecision(message);
          }
          return false;
        }
      }
    }));

    const status = await runtime.start("environment");
    expect(observed).toMatchObject({
      publicValue: "public-value",
      secretValue: secret,
      forbiddenValue: null
    });
    expect(status.stdout.truncated).toBe(true);
    expect(status.stdout.lines[0]).toBe("[TRUNCATED]");
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("inline-private-token");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("must-not-cross");
  });

  it("rejects non-loopback readiness endpoints and exposes non-authoritative degradation state", async () => {
    const runtime = manager();
    expect(() => runtime.register(definition("remote", "ready", {
      readiness: { kind: "HTTP_LOOPBACK", url: "http://example.com/health" }
    }))).toThrow(LocalRuntimeError);

    runtime.register(definition("health", "ready"));
    await runtime.start("health");
    expect(runtime.markDegraded("health", "probe missed one interval").state).toBe("DEGRADED");
    expect(runtime.markReady("health").state).toBe("READY");
  });
});
