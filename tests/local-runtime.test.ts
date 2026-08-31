import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalRuntimeError,
  LocalRuntimeManager,
  buildLocalEnvironment,
  type LocalComponentDefinition,
  type LocalComponentHandshake
} from "../packages/local-runtime/src/index.js";
import { BoundedLineBuffer, BoundedLineFramer, redactKnownSecrets } from "../packages/local-runtime/src/buffer.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/local-runtime-worker.mjs", import.meta.url));
const temporaryRoots: string[] = [];
const managers: LocalRuntimeManager[] = [];
const fixturePids: number[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    try {
      await manager.stopAll();
    } catch {
      // Cleanup continues so one failed stop does not leak other fixture workers.
    }
  }
  for (const pid of fixturePids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
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
  it("rejects accessor-backed manager and start options without executing them", async () => {
    let constructorGetterCalls = 0;
    const hostileManagerOptions = Object.defineProperty({}, "fetch", {
      enumerable: true,
      get: () => {
        constructorGetterCalls += 1;
        return globalThis.fetch;
      }
    });
    expect(() => new LocalRuntimeManager(
      hostileManagerOptions as ConstructorParameters<typeof LocalRuntimeManager>[0]
    )).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(constructorGetterCalls).toBe(0);

    expect(() => new LocalRuntimeManager({
      fetch: 42 as unknown as typeof globalThis.fetch
    })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));

    let parentEnvironmentProxyTraps = 0;
    const proxiedParentEnvironment = new Proxy({ PATH: process.env.PATH }, {
      ownKeys: (target) => {
        parentEnvironmentProxyTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, key) => {
        parentEnvironmentProxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    expect(() => new LocalRuntimeManager({
      parentEnvironment: proxiedParentEnvironment
    })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(parentEnvironmentProxyTraps).toBe(0);

    let parentEnvironmentGetterCalls = 0;
    const accessorParentEnvironment = Object.defineProperty({}, "SAFE_PARENT", {
      enumerable: true,
      get: () => {
        parentEnvironmentGetterCalls += 1;
        return "hidden";
      }
    });
    expect(() => new LocalRuntimeManager({
      parentEnvironment: accessorParentEnvironment as NodeJS.ProcessEnv
    })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(parentEnvironmentGetterCalls).toBe(0);

    expect(() => new LocalRuntimeManager({
      parentEnvironment: new Date() as unknown as NodeJS.ProcessEnv
    })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));

    expect(() => new LocalRuntimeManager({
      parentEnvironment: {
        BAD_VALUE: 42 as unknown as string
      }
    })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));

    expect(() => new LocalRuntimeManager({
      parentEnvironment: process.env
    })).not.toThrow();

    const runtime = manager();
    runtime.register(definition("invalid-start-options", "ready"));
    let signalGetterCalls = 0;
    const hostileStartOptions = Object.defineProperty({}, "signal", {
      enumerable: true,
      get: () => {
        signalGetterCalls += 1;
        return new AbortController().signal;
      }
    });
    expect(() => runtime.start(
      "invalid-start-options",
      hostileStartOptions as { readonly signal?: AbortSignal }
    )).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(signalGetterCalls).toBe(0);

    expect(() => runtime.start("invalid-start-options", {
      signal: {} as AbortSignal
    })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));

    let signalProxyTraps = 0;
    const proxiedSignal = new Proxy(new AbortController().signal, {
      get: (target, key, receiver) => {
        signalProxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf: (target) => {
        signalProxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      }
    });
    expect(() => runtime.start("invalid-start-options", {
      signal: proxiedSignal
    })).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(signalProxyTraps).toBe(0);

    let clockProxyTraps = 0;
    const proxiedDate = new Proxy(new Date(), {
      get: (target, key, receiver) => {
        clockProxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf: (target) => {
        clockProxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      }
    });
    const proxyClock = manager({ now: () => proxiedDate });
    proxyClock.register(definition("proxy-clock", "ready"));
    await expect(proxyClock.start("proxy-clock")).resolves.toMatchObject({ state: "READY" });
    expect(clockProxyTraps).toBe(0);

    await expect(runtime.start("invalid-start-options"))
      .resolves.toMatchObject({ state: "READY" });
  });

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

  it("returns deeply immutable observational status snapshots", async () => {
    const runtime = manager();
    runtime.register(definition("immutable-status", "ready", {
      readiness: {
        kind: "CUSTOM_LOCAL",
        probe: () => ({
          ready: true,
          detail: "healthy",
          handshake: {
            componentVersion: "fixture-1",
            capabilities: ["CAPABILITY_A"],
            metadata: {
              nested: { value: "x" },
              items: ["y"]
            }
          }
        })
      }
    }));

    const status = await runtime.start("immutable-status");
    const metadata = status.handshake?.metadata as
      | { readonly nested?: Readonly<Record<string, unknown>>; readonly items?: readonly unknown[] }
      | undefined;

    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.readiness)).toBe(true);
    expect(Object.isFrozen(status.stdout)).toBe(true);
    expect(Object.isFrozen(status.stdout.lines)).toBe(true);
    expect(Object.isFrozen(status.handshake)).toBe(true);
    expect(Object.isFrozen(status.handshake?.capabilities)).toBe(true);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata?.nested)).toBe(true);
    expect(Object.isFrozen(metadata?.items)).toBe(true);

    const statuses = runtime.listStatuses();
    expect(Object.isFrozen(statuses)).toBe(true);
    expect(Object.isFrozen(statuses[0])).toBe(true);
  });

  it("lets a joining start caller cancel its own wait without cancelling the shared start", async () => {
    const runtime = manager();
    runtime.register(definition("joined-cancel", "delayed-ready", {
      startupTimeoutMs: 1_000
    }, ["120"]));

    const owner = runtime.start("joined-cancel");
    await waitForStatus(runtime, "joined-cancel", (status) => status.state === "STARTING");

    const controller = new AbortController();
    const joined = runtime.start("joined-cancel", { signal: controller.signal });
    controller.abort();

    await expect(joined).rejects.toMatchObject({ code: "START_CANCELLED" });
    await expect(owner).resolves.toMatchObject({ state: "READY" });
    expect(runtime.getStatus("joined-cancel").state).toBe("READY");
  });

  it("times out readiness and ignores malformed stdout as trusted protocol", async () => {
    const runtime = manager();
    runtime.register(definition("malformed", "malformed-ready", { startupTimeoutMs: 100 }));

    await expect(runtime.start("malformed")).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(runtime.getStatus("malformed").state).toBe("FAILED");
    expect(runtime.getStatus("malformed").stdout.lines.join(" ")).toContain("{not-json");
  });

  it("fails hanging readiness probes immediately when the child exits", async () => {
    const custom = manager();
    custom.register(definition("custom-exit-race", "crash", {
      startupTimeoutMs: 500,
      readiness: {
        kind: "CUSTOM_LOCAL",
        probe: () => new Promise<never>(() => undefined)
      }
    }));

    await expect(custom.start("custom-exit-race"))
      .rejects.toMatchObject({ code: "PROCESS_EXITED" });

    const http = manager({
      fetch: (() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch
    });
    http.register(definition("http-exit-race", "crash", {
      startupTimeoutMs: 500,
      readiness: {
        kind: "HTTP_LOOPBACK",
        url: "http://127.0.0.1:43199/health",
        intervalMs: 5
      }
    }));

    await expect(http.start("http-exit-race"))
      .rejects.toMatchObject({ code: "PROCESS_EXITED" });
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
    const stoppedGraceful = runtime.getStatus("graceful");
    expect(stoppedGraceful.state).toBe("STOPPED");
    expect(stoppedGraceful).not.toHaveProperty("handshake");
    expect(stoppedGraceful).not.toHaveProperty("readyAt");
    expect(stoppedGraceful.readiness).not.toHaveProperty("detail");
    await expect(runtime.stop("graceful")).resolves.toMatchObject({ disposition: "ALREADY_STOPPED" });

    runtime.register(definition("slow", "delayed-ready", { startupTimeoutMs: 1_000 }, ["500"]));
    const start = runtime.start("slow");
    await waitForStatus(runtime, "slow", (status) => status.state === "STARTING");
    await runtime.stop("slow");
    await expect(start).rejects.toMatchObject({ code: "START_CANCELLED" });
    expect(runtime.getStatus("slow").state).toBe("STOPPED");
  });

  it("restarts a ready component through the public restart API", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-runtime-explicit-restart-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    runtime.register(definition("explicit-restart", "ready-counter", {}, [counter]));

    const first = await runtime.start("explicit-restart");
    expect(first.state).toBe("READY");
    expect(readFileSync(counter, "utf8")).toBe("1");

    const second = await runtime.restart("explicit-restart");
    expect(second.state).toBe("READY");
    expect(readFileSync(counter, "utf8")).toBe("2");
    expect(second.lastExit).toMatchObject({
      code: 0,
      signal: null,
      unexpected: false
    });
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

  it("cancels cleanly while waiting in retry backoff", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-runtime-backoff-cancel-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    const controller = new AbortController();

    runtime.register(definition("retry-cancel", "always-crash-counter", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 3, backoffMs: 30, maxBackoffMs: 30 }
    }, [counter]));

    const start = runtime.start("retry-cancel", { signal: controller.signal });
    await waitForStatus(runtime, "retry-cancel", (status) =>
      status.state === "FAILED" && status.restartCount === 1
    );
    controller.abort();

    await expect(start).rejects.toMatchObject({ code: "START_CANCELLED" });
    expect(runtime.getStatus("retry-cancel").state).toBe("STOPPED");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(counter, "utf8")).toBe("1");
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

  it("resets the retry budget for an explicit new start after exhaustion", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-runtime-retry-reset-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    runtime.register(definition("retry-reset", "crash-counter", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 1, backoffMs: 5 }
    }, [counter, "2"]));

    await expect(runtime.start("retry-reset")).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(readFileSync(counter, "utf8")).toBe("2");
    expect(runtime.getStatus("retry-reset").restartCount).toBe(1);

    const recovered = await runtime.start("retry-reset");
    expect(recovered.state).toBe("READY");
    expect(readFileSync(counter, "utf8")).toBe("3");
    expect(recovered.restartCount).toBe(1);
  });

  it("stops cleanly during automatic post-crash restart backoff", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-runtime-auto-backoff-stop-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    runtime.register(definition("auto-backoff-stop", "ready-crash-counter", {
      restartPolicy: {
        mode: "ON_FAILURE",
        maxRetries: 2,
        backoffMs: 120,
        maxBackoffMs: 120
      },
      terminationTimeoutMs: 200
    }, [counter, "30"]));

    await runtime.start("auto-backoff-stop");
    await waitForStatus(runtime, "auto-backoff-stop", (status) =>
      status.state === "FAILED"
        && status.restartCount === 1
        && readFileSync(counter, "utf8") === "1"
    );

    await runtime.stop("auto-backoff-stop");
    expect(runtime.getStatus("auto-backoff-stop").state).toBe("STOPPED");
    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    expect(readFileSync(counter, "utf8")).toBe("1");
    expect(runtime.getStatus("auto-backoff-stop").state).toBe("STOPPED");
  });

  it("detects post-readiness crashes and spends the same bounded restart budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-runtime-late-crash-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    runtime.register(definition("late-crash", "ready-crash-counter", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 1, backoffMs: 5 }
    }, [counter, "40"]));
    await runtime.start("late-crash");

    await waitForStatus(runtime, "late-crash", (status) =>
      status.state === "FAILED"
        && status.restartCount === 1
        && readFileSync(counter, "utf8") === "2"
    );
    const status = runtime.getStatus("late-crash");
    expect(status).toMatchObject({ state: "FAILED", restartCount: 1 });
    expect(status.lastExit?.unexpected).toBe(true);
    expect(status).not.toHaveProperty("handshake");
    expect(status).not.toHaveProperty("readyAt");
    expect(status.readiness).not.toHaveProperty("detail");
    expect(readFileSync(counter, "utf8")).toBe("2");
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

  it("redacts multiline runtime secrets after framing and JSON escaping", async () => {
    const secret = "multiline-private-alpha\nmultiline-private-omega";
    const runtime = manager();
    runtime.register(definition("multiline-secret", "output-env", {
      environment: {
        secrets: { RUNTIME_ONLY_SECRET: secret }
      },
      readiness: {
        kind: "STDOUT_JSON",
        evaluate: (message) => readyDecision(message)
      }
    }));

    const status = await runtime.start("multiline-secret");
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("multiline-private-alpha");
    expect(serialized).not.toContain("multiline-private-omega");
    expect(serialized).toContain("[REDACTED]");

    const built = buildLocalEnvironment({
      secrets: { MULTILINE_SECRET: secret }
    }, {});
    expect(built.secretValues).toContain("multiline-private-alpha");
    expect(built.secretValues).toContain("multiline-private-omega");
    expect(built.secretValues).toContain("multiline-private-alpha\\nmultiline-private-omega");
  });

  it("does not reprocess runtime redaction markers as later secrets", async () => {
    const runtime = manager();
    runtime.register(definition("overlap-redaction", "output-env", {
      environment: {
        secrets: {
          RUNTIME_ONLY_SECRET: "abcdef",
          SECOND_RUNTIME_SECRET: "["
        }
      },
      readiness: {
        kind: "STDOUT_JSON",
        evaluate: (message) => readyDecision(message)
      }
    }));

    const status = await runtime.start("overlap-redaction");
    const stderr = status.stderr.lines.join("\n");
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).not.toContain("[REDACTED]REDACTED]");
  });

  it("rejects non-string HTTP readiness URLs without coercion", () => {
    const runtime = manager();
    let coercions = 0;
    const hostileUrl = {
      toString: () => {
        coercions += 1;
        return "http://127.0.0.1:43199/health";
      }
    };

    expect(() => runtime.register(definition("coercive-url", "ready", {
      readiness: {
        kind: "HTTP_LOOPBACK",
        url: hostileUrl
      } as unknown as LocalComponentDefinition["readiness"]
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
    expect(coercions).toBe(0);
  });

  it("rejects malformed injected HTTP Response values without proxy observation", async () => {
    const plain = manager({
      fetch: (() => Promise.resolve({ ok: true })) as unknown as typeof globalThis.fetch
    });
    plain.register(definition("invalid-http-response", "ready", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 2, backoffMs: 5 },
      readiness: {
        kind: "HTTP_LOOPBACK",
        url: "http://127.0.0.1:43199/health",
        intervalMs: 5
      }
    }));

    await expect(plain.start("invalid-http-response"))
      .rejects.toMatchObject({ code: "READINESS_FAILED" });
    expect(plain.getStatus("invalid-http-response").restartCount).toBe(0);

    let responseProxyTraps = 0;
    const proxiedResponse = new Proxy(new Response(null, { status: 204 }), {
      get: (target, key, receiver) => {
        responseProxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
      getPrototypeOf: (target) => {
        responseProxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      }
    });
    const proxied = manager({
      fetch: (() => Promise.resolve(proxiedResponse)) as unknown as typeof globalThis.fetch
    });
    proxied.register(definition("proxy-http-response", "ready", {
      readiness: {
        kind: "HTTP_LOOPBACK",
        url: "http://127.0.0.1:43199/health",
        intervalMs: 5
      }
    }));

    await expect(proxied.start("proxy-http-response"))
      .rejects.toMatchObject({ code: "READINESS_FAILED" });
    expect(responseProxyTraps).toBe(0);
  });

  it("ignores shadow accessors on validated HTTP Response objects", async () => {
    let shadowGetterCalls = 0;
    const response = new Response(null, { status: 204 });
    for (const key of ["redirected", "status", "ok", "body"] as const) {
      Object.defineProperty(response, key, {
        configurable: true,
        enumerable: true,
        get: () => {
          shadowGetterCalls += 1;
          throw new Error(`shadow getter ${key} should not run`);
        }
      });
    }

    const runtime = manager({
      fetch: () => Promise.resolve(response)
    });
    runtime.register(definition("shadowed-http-response", "ready", {
      readiness: {
        kind: "HTTP_LOOPBACK",
        url: "http://127.0.0.1:43199/health",
        intervalMs: 5
      }
    }));

    await expect(runtime.start("shadowed-http-response"))
      .resolves.toMatchObject({ state: "READY" });
    expect(shadowGetterCalls).toBe(0);
  });

  it("rejects HTTP readiness redirects even when an injected fetch returns them", async () => {
    let evaluateCalls = 0;
    const runtime = manager({
      fetch: () => Promise.resolve(new Response(null, {
        status: 302,
        headers: { Location: "http://example.com/escaped" }
      }))
    });
    runtime.register(definition("redirect-health", "ready", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 2, backoffMs: 5 },
      readiness: {
        kind: "HTTP_LOOPBACK",
        url: "http://127.0.0.1:43199/health",
        evaluate: () => {
          evaluateCalls += 1;
          return true;
        }
      }
    }));

    await expect(runtime.start("redirect-health"))
      .rejects.toMatchObject({ code: "READINESS_FAILED" });
    expect(evaluateCalls).toBe(0);
    expect(runtime.getStatus("redirect-health").restartCount).toBe(0);
  });

  it("canonicalizes localhost readiness probes to a literal loopback address", async () => {
    let requestedUrl: string | undefined;
    const runtime = manager({
      fetch: (input) => {
        requestedUrl = String(input);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
    });
    runtime.register(definition("localhost-health", "ready", {
      readiness: {
        kind: "HTTP_LOOPBACK",
        url: "http://localhost:43199/health"
      }
    }));

    await expect(runtime.start("localhost-health")).resolves.toMatchObject({ state: "READY" });
    expect(requestedUrl).toBe("http://127.0.0.1:43199/health");
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

    let coercions = 0;
    const hostileString = {
      toString: () => {
        coercions += 1;
        return "coerced";
      }
    };
    expect(() => runtime.getStatus(hostileString as unknown as string))
      .toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => runtime.getStatus("x".repeat(129)))
      .toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => runtime.getStatus("contains space"))
      .toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => runtime.markDegraded("health", hostileString as unknown as string))
      .toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => runtime.markReady("health", hostileString as unknown as string))
      .toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(coercions).toBe(0);
  });


  it("supports stable-process, stdout-line, custom, and loopback HTTP readiness", async () => {
    const runtime = manager({
      fetch: (() => {
        let attempt = 0;
        return (_input: string | URL | Request, _init?: RequestInit) => {
          attempt += 1;
          return Promise.resolve(new Response("probe", { status: attempt < 2 ? 503 : 200 }));
        };
      })()
    });

    runtime.register(definition("stable", "ready", {
      readiness: { kind: "STABLE_PROCESS", stableMs: 20 }
    }));
    await expect(runtime.start("stable")).resolves.toMatchObject({ state: "READY" });

    runtime.register(definition("line", "early-line-ready", {
      readiness: {
        kind: "STDOUT_LINE",
        evaluate: (line) => line === "READY-LINE"
      },
      output: { maxLines: 8, maxBytes: 1_024, maxLineBytes: 1_024 }
    }));
    const lineStatus = await runtime.start("line");
    expect(lineStatus.state).toBe("READY");
    expect(lineStatus.stdout.truncated).toBe(true);

    let probeCount = 0;
    const runtimeSecret = "custom-detail-private-4821";
    runtime.register(definition("custom", "ready", {
      environment: { secrets: { RUNTIME_ONLY_SECRET: runtimeSecret } },
      readiness: {
        kind: "CUSTOM_LOCAL",
        intervalMs: 5,
        probe: () => {
          probeCount += 1;
          return probeCount < 2
            ? false
            : { ready: true, detail: `ready ${runtimeSecret}` };
        }
      }
    }));
    const customStatus = await runtime.start("custom");
    expect(customStatus.readiness.detail).toContain("[REDACTED]");
    expect(JSON.stringify(customStatus)).not.toContain(runtimeSecret);
    const degraded = runtime.markDegraded("custom", `degraded ${runtimeSecret}`);
    expect(JSON.stringify(degraded)).not.toContain(runtimeSecret);

    runtime.register(definition("http", "ready", {
      readiness: {
        kind: "HTTP_LOOPBACK",
        url: "http://127.0.0.1:43199/health",
        intervalMs: 5
      }
    }));
    await expect(runtime.start("http")).resolves.toMatchObject({ state: "READY" });
  });

  it("cancels startup externally and cleans up the spawned process", async () => {
    const runtime = manager();
    runtime.register(definition("cancelled", "delayed-ready", {
      startupTimeoutMs: 1_000,
      terminationTimeoutMs: 300
    }, ["500"]));
    const controller = new AbortController();
    const starting = runtime.start("cancelled", { signal: controller.signal });
    await waitForStatus(runtime, "cancelled", (status) => status.state === "STARTING");
    controller.abort();

    await expect(starting).rejects.toMatchObject({ code: "START_CANCELLED" });
    expect(runtime.getStatus("cancelled")).toMatchObject({
      state: "STOPPED",
      readiness: { ready: false }
    });
    expect(runtime.getStatus("cancelled")).not.toHaveProperty("pid");
  });

  it("does not commit READY when stop is requested from a readiness callback", async () => {
    const runtime = manager();
    let stopping: ReturnType<LocalRuntimeManager["stop"]> | undefined;
    runtime.register(definition("readiness-stop-race", "line-ready", {
      readiness: {
        kind: "STDOUT_LINE",
        evaluate: (line) => {
          if (line !== "READY-LINE") return false;
          stopping = runtime.stop("readiness-stop-race");
          return true;
        }
      }
    }));

    const starting = runtime.start("readiness-stop-race");
    await expect(starting).rejects.toMatchObject({ code: "START_CANCELLED" });
    expect(stopping).toBeDefined();
    if (stopping !== undefined) await stopping;
    expect(runtime.getStatus("readiness-stop-race").state).toBe("STOPPED");
  });

  it("lets stop own graceful cleanup when cancellation happens during STARTING", async () => {
    const runtime = manager();
    runtime.register(definition("starting-stop", "delayed-stdin-shutdown", {
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 300,
      terminationTimeoutMs: 300,
      gracefulShutdown: (control) => control.writeStdin("shutdown-now\n")
    }, ["500"]));

    const starting = runtime.start("starting-stop");
    await waitForStatus(runtime, "starting-stop", (status) => status.state === "STARTING");
    const stopping = runtime.stop("starting-stop");

    await expect(starting).rejects.toMatchObject({ code: "START_CANCELLED" });
    await expect(stopping).resolves.toMatchObject({ disposition: "GRACEFUL" });
    expect(runtime.getStatus("starting-stop").lastExit).toMatchObject({
      code: 0,
      signal: null,
      unexpected: false
    });
  });

  it("does not let a never-resolving graceful hook hang stop", async () => {
    const runtime = manager();
    runtime.register(definition("hung-hook", "ready", {
      shutdownTimeoutMs: 40,
      terminationTimeoutMs: 300,
      gracefulShutdown: () => new Promise<void>(() => undefined)
    }));
    await runtime.start("hung-hook");

    const stopped = await runtime.stop("hung-hook");
    expect(stopped.disposition).toBe("TERMINATED");
    expect(runtime.getStatus("hung-hook").state).toBe("STOPPED");
  });

  it("fails a version mismatch and proves the rejected process is gone", async () => {
    const runtime = manager();
    runtime.register(definition("bad-version", "ready", {
      expectedHandshake: { protocolVersion: 2 },
      terminationTimeoutMs: 300
    }));

    await expect(runtime.start("bad-version")).rejects.toMatchObject({ code: "HANDSHAKE_MISMATCH" });
    const status = runtime.getStatus("bad-version");
    expect(status.state).toBe("FAILED");
    expect(status).not.toHaveProperty("pid");
  });

  it("copies process definitions at registration so caller mutation cannot change execution", async () => {
    const runtime = manager();
    const args = [FIXTURE, "ready"];
    const mutableDefinition: LocalComponentDefinition = {
      id: "immutable",
      executable: process.execPath,
      args,
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 200,
      readiness: {
        kind: "STDOUT_JSON",
        evaluate: (message) => readyDecision(message)
      }
    };
    runtime.register(mutableDefinition);
    args[1] = "crash";

    await expect(runtime.start("immutable")).resolves.toMatchObject({ state: "READY" });
  });

  it("rejects timer overflow and malformed runtime definitions before spawning", () => {
    const runtime = manager();
    expect(() => runtime.register(definition("too-long", "ready", {
      startupTimeoutMs: 2_147_483_648
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register({
      ...definition("bad-args", "ready"),
      args: [42] as unknown as string[]
    })).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register({
      ...definition("bad-readiness", "ready"),
      readiness: { kind: "UNKNOWN" } as unknown as LocalComponentDefinition["readiness"]
    })).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register({
      ...definition("bad-restart", "ready"),
      restartPolicy: {
        mode: "ON_FAILURE",
        maxRetries: 1,
        backoffMs: 2_147_483_648
      }
    })).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
  });

  it("drops oversized stdout frames without blocking a later valid readiness message", async () => {
    const runtime = manager();
    runtime.register(definition("oversized-output", "oversized-then-ready", {
      output: { maxLines: 4, maxBytes: 256, maxLineBytes: 128 }
    }, ["4096"]));

    const status = await runtime.start("oversized-output");
    expect(status.state).toBe("READY");
    expect(status.stdout.lines).toContain("[MALFORMED_OUTPUT]");
    expect(status.stdout.lines.length).toBeLessThanOrEqual(4);
    const retainedBytes = status.stdout.lines.reduce(
      (total, line) => total + Buffer.byteLength(line, "utf8"),
      0
    );
    expect(retainedBytes).toBeLessThanOrEqual(256);
  });

  it("keeps crash stderr tails isolated to the process attempt that actually exited", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-runtime-crash-tail-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    runtime.register(definition("crash-tail", "ready-crash-counter", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 1, backoffMs: 5 },
      terminationTimeoutMs: 300
    }, [counter, "40"]));
    await runtime.start("crash-tail");

    await waitForStatus(runtime, "crash-tail", (status) =>
      status.state === "FAILED" && status.restartCount === 1 && status.lastExit?.code === 14
    );
    const status = runtime.getStatus("crash-tail");
    expect(status.lastExit?.stderrTail.join(" ")).toContain("crash-attempt-2");
    expect(status.lastExit?.stderrTail.join(" ")).not.toContain("crash-attempt-1");
  });

  it("snapshots the manager parent environment before later caller mutation", async () => {
    const parentEnvironment = {
      PATH: process.env.PATH,
      SAFE_PARENT: "snapshot-parent-value"
    };
    const runtime = manager({ parentEnvironment });
    parentEnvironment.SAFE_PARENT = "mutated-parent-value";

    let observed: Record<string, unknown> | undefined;
    runtime.register(definition("parent-snapshot", "output-env", {
      environment: { inherit: ["SAFE_PARENT"] },
      readiness: {
        kind: "STDOUT_JSON",
        evaluate: (message) => {
          if (typeof message === "object" && message !== null
              && (message as Record<string, unknown>).type === "READY") {
            observed = message as Record<string, unknown>;
            return readyDecision(message);
          }
          return false;
        }
      }
    }));

    await runtime.start("parent-snapshot");
    expect(observed).toMatchObject({ inheritedValue: "snapshot-parent-value" });
  });

  it("rejects inherited parent values containing NUL before spawning", () => {
    expect(() => buildLocalEnvironment(
      { inherit: ["SAFE_PARENT"] },
      { SAFE_PARENT: "invalid\0parent-value" },
      "linux"
    )).toThrow(/contains a NUL byte/iu);

    const runtime = manager({
      parentEnvironment: {
        PATH: process.env.PATH,
        SAFE_PARENT: "invalid\0parent-value"
      }
    });
    expect(() => runtime.register(definition("invalid-inherited-value", "ready", {
      environment: { inherit: ["SAFE_PARENT"] }
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
  });

  it("uses platform-specific default inheritance and explicit inherited variables", async () => {
    const posix = buildLocalEnvironment(
      { inherit: ["SAFE_PARENT"] },
      { PATH: "safe-path", Path: "wrong-case-path", SAFE_PARENT: "allowed" },
      "linux"
    );
    expect(posix.environment).toMatchObject({ PATH: "safe-path", SAFE_PARENT: "allowed" });
    expect(posix.environment).not.toHaveProperty("Path");

    expect(() => buildLocalEnvironment(
      undefined,
      { Path: "first-path", PATH: "second-path" },
      "win32"
    )).toThrow(/Ambiguous case-insensitive parent environment key/iu);

    const windows = buildLocalEnvironment(
      undefined,
      { Path: "windows-path", SYSTEMROOT: "windows-root", TMPDIR: "posix-only" },
      "win32"
    );
    expect(windows.environment).toMatchObject({ Path: "windows-path", SYSTEMROOT: "windows-root" });
    expect(windows.environment).not.toHaveProperty("TMPDIR");

    const runtime = manager({
      parentEnvironment: {
        PATH: process.env.PATH,
        SAFE_PARENT: "inherited-safe-value"
      }
    });
    let observed: Record<string, unknown> | undefined;
    runtime.register(definition("inherited", "output-env", {
      environment: { inherit: ["SAFE_PARENT"] },
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
    await runtime.start("inherited");
    expect(observed).toMatchObject({ inheritedValue: "inherited-safe-value" });
  });

  it("fails closed when Windows tree-aware termination is unavailable", async () => {
    if (process.platform !== "win32") return;

    const originalSystemRoot = process.env.SystemRoot;
    const originalUpperSystemRoot = process.env.SYSTEMROOT;
    const runtime = manager();
    runtime.register(definition("unverified-windows-tree", "ignore-shutdown", {
      shutdownTimeoutMs: 20,
      terminationTimeoutMs: 40,
      gracefulShutdown: () => undefined
    }));

    await runtime.start("unverified-windows-tree");
    try {
      process.env.SystemRoot = "relative-untrusted-root";
      delete process.env.SYSTEMROOT;
      await expect(runtime.stop("unverified-windows-tree"))
        .rejects.toMatchObject({ code: "TERMINATION_FAILED" });
      expect(runtime.getStatus("unverified-windows-tree").state).toBe("FAILED");
      await expect(runtime.start("unverified-windows-tree"))
        .rejects.toMatchObject({ code: "INVALID_STATE" });
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
      if (originalUpperSystemRoot === undefined) delete process.env.SYSTEMROOT;
      else process.env.SYSTEMROOT = originalUpperSystemRoot;
    }
  });

  it("terminates an owned descendant tree during escalation", async () => {
    const runtime = manager();
    let childPid: number | undefined;
    runtime.register(definition("tree", "tree-parent-ignore", {
      shutdownTimeoutMs: 50,
      terminationTimeoutMs: 500,
      gracefulShutdown: () => undefined,
      readiness: {
        kind: "STDOUT_JSON",
        evaluate: (message) => {
          if (typeof message !== "object" || message === null) return false;
          const value = message as Record<string, unknown>;
          if (typeof value.childPid === "number") {
            childPid = value.childPid;
            fixturePids.push(value.childPid);
          }
          return readyDecision(message);
        }
      }
    }));
    await runtime.start("tree");
    expect(childPid).toBeTypeOf("number");

    const result = await runtime.stop("tree");
    expect(result.disposition).not.toBe("GRACEFUL");
    if (childPid !== undefined) {
      await waitForPidExit(childPid);
      expect(isPidAlive(childPid)).toBe(false);
    }
  });

  it("cleans an owned descendant tree after an unexpected parent crash", async () => {
    const runtime = manager();
    let childPid: number | undefined;
    runtime.register(definition("crashed-tree", "tree-parent-crash", {
      terminationTimeoutMs: 500,
      restartPolicy: { mode: "NEVER" },
      readiness: {
        kind: "STDOUT_JSON",
        evaluate: (message) => {
          if (typeof message !== "object" || message === null) return false;
          const value = message as Record<string, unknown>;
          if (typeof value.childPid === "number") {
            childPid = value.childPid;
            fixturePids.push(value.childPid);
          }
          return readyDecision(message);
        }
      }
    }, ["40"]));

    await runtime.start("crashed-tree");
    expect(childPid).toBeTypeOf("number");
    await waitForStatus(runtime, "crashed-tree", (status) =>
      status.state === "FAILED" && status.lastExit?.code === 16
    );
    if (childPid !== undefined) {
      await waitForPidExit(childPid);
      expect(isPidAlive(childPid)).toBe(false);
    }
  });

  it("lets an explicit start queued during crash cleanup reset the retry budget", async () => {
    if (process.platform === "win32") return;

    const root = mkdtempSync(join(tmpdir(), "local-runtime-cleanup-manual-start-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    let childPid: number | undefined;
    let queuedStart: ReturnType<LocalRuntimeManager["start"]> | undefined;
    let watcher: ReturnType<typeof setInterval> | undefined;

    runtime.register(definition("cleanup-manual-start", "tree-crash-once-counter", {
      terminationTimeoutMs: 200,
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 1, backoffMs: 50 },
      readiness: {
        kind: "STDOUT_JSON",
        evaluate: (message) => {
          if (typeof message !== "object" || message === null) return false;
          const value = message as Record<string, unknown>;
          if (typeof value.childPid === "number") {
            childPid = value.childPid;
            fixturePids.push(value.childPid);
          }
          if (value.attempt === 1 && watcher === undefined) {
            watcher = setInterval(() => {
              if (runtime.getStatus("cleanup-manual-start").state !== "FAILED") return;
              if (watcher !== undefined) clearInterval(watcher);
              watcher = undefined;
              queuedStart = runtime.start("cleanup-manual-start");
            }, 1);
          }
          return readyDecision(message);
        }
      }
    }, [counter, "40"]));

    try {
      await runtime.start("cleanup-manual-start");
      await waitForStatus(runtime, "cleanup-manual-start", (status) =>
        status.state === "FAILED" && status.lastExit?.code === 17
      );
      const deadline = performance.now() + 1_000;
      while (queuedStart === undefined && performance.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      expect(queuedStart).toBeDefined();
      const recovered = await queuedStart;
      expect(recovered.state).toBe("READY");
      expect(recovered.restartCount).toBe(0);
      expect(readFileSync(counter, "utf8")).toBe("2");
      if (childPid !== undefined) {
        await waitForPidExit(childPid);
        expect(isPidAlive(childPid)).toBe(false);
      }
    } finally {
      if (watcher !== undefined) clearInterval(watcher);
    }
  });

  it("lets a start queued behind stop cancel without spawning afterward", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-runtime-queued-stop-cancel-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    runtime.register(definition("queued-stop-cancel", "ready-counter", {
      shutdownTimeoutMs: 40,
      terminationTimeoutMs: 150,
      gracefulShutdown: () => new Promise<void>(() => undefined)
    }, [counter]));

    await runtime.start("queued-stop-cancel");
    expect(readFileSync(counter, "utf8")).toBe("1");

    const stopping = runtime.stop("queued-stop-cancel");
    await waitForStatus(runtime, "queued-stop-cancel", (status) => status.state === "STOPPING");

    const controller = new AbortController();
    const queued = runtime.start("queued-stop-cancel", { signal: controller.signal });
    controller.abort();

    await expect(queued).rejects.toMatchObject({ code: "START_CANCELLED" });
    await expect(stopping).resolves.toMatchObject({
      componentId: "queued-stop-cancel"
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(readFileSync(counter, "utf8")).toBe("1");
    expect(runtime.getStatus("queued-stop-cancel").state).toBe("STOPPED");

    const restarted = await runtime.start("queued-stop-cancel");
    expect(restarted.state).toBe("READY");
    expect(readFileSync(counter, "utf8")).toBe("2");
  });

  it("serializes reentrant start behind an in-progress stop", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-runtime-reentrant-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    let restarted: ReturnType<LocalRuntimeManager["start"]> | undefined;
    runtime.register(definition("reentrant", "ready-counter", {
      shutdownTimeoutMs: 300,
      terminationTimeoutMs: 300,
      gracefulShutdown: (control) => {
        restarted = runtime.start("reentrant");
        control.endStdin();
      }
    }, [counter]));

    await runtime.start("reentrant");
    expect(readFileSync(counter, "utf8")).toBe("1");
    await expect(runtime.stop("reentrant")).resolves.toMatchObject({ disposition: "GRACEFUL" });
    expect(restarted).toBeDefined();
    const second = await restarted;
    expect(second.state).toBe("READY");
    expect(readFileSync(counter, "utf8")).toBe("2");
  });

  it("prevents new managed work from entering while stopAll is in progress", async () => {
    const runtime = manager();
    runtime.register(definition("late", "ready"));
    let startFailure: unknown;
    let registerFailure: unknown;
    runtime.register(definition("blocker", "stdin-shutdown", {
      gracefulShutdown: async (control) => {
        try {
          await runtime.start("late");
        } catch (error) {
          startFailure = error;
        }
        try {
          runtime.register(definition("new-during-stop-all", "ready"));
        } catch (error) {
          registerFailure = error;
        }
        await control.writeStdin("shutdown-now\n");
      }
    }));
    await runtime.start("blocker");

    await runtime.stopAll();
    expect(startFailure).toMatchObject({ code: "INVALID_STATE" });
    expect(registerFailure).toMatchObject({ code: "INVALID_STATE" });
    expect(runtime.listStatuses().map((status) => status.state)).toEqual(["STOPPED", "STOPPED"]);
  });

  it("does not retry deterministic version-handshake mismatches", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-runtime-version-"));
    temporaryRoots.push(root);
    const counter = join(root, "counter.txt");
    const runtime = manager();
    runtime.register(definition("version-no-retry", "ready-counter", {
      expectedHandshake: { protocolVersion: 2 },
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 3, backoffMs: 5 }
    }, [counter]));

    await expect(runtime.start("version-no-retry")).rejects.toMatchObject({ code: "HANDSHAKE_MISMATCH" });
    expect(readFileSync(counter, "utf8")).toBe("1");
    expect(runtime.getStatus("version-no-retry").restartCount).toBe(0);
  });

  it("fails immediately on malformed readiness decision shapes", async () => {
    const custom = manager();
    let probeCalls = 0;
    custom.register(definition("bad-custom-decision", "ready", {
      startupTimeoutMs: 1_000,
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 3, backoffMs: 5 },
      readiness: {
        kind: "CUSTOM_LOCAL",
        probe: () => {
          probeCalls += 1;
          return { ready: "yes" } as unknown as { readonly ready: boolean };
        }
      }
    }));
    await expect(custom.start("bad-custom-decision"))
      .rejects.toMatchObject({ code: "READINESS_FAILED" });
    expect(probeCalls).toBe(1);
    expect(custom.getStatus("bad-custom-decision").restartCount).toBe(0);

    const stdout = manager();
    stdout.register(definition("bad-stdout-decision", "line-ready", {
      startupTimeoutMs: 1_000,
      readiness: {
        kind: "STDOUT_LINE",
        evaluate: () => ({ ready: "yes" } as unknown as { readonly ready: boolean })
      }
    }));
    await expect(stdout.start("bad-stdout-decision"))
      .rejects.toMatchObject({ code: "READINESS_FAILED" });
  });

  it("rejects proxy-backed handshake capabilities without executing traps", async () => {
    let capabilityProxyTraps = 0;
    const capabilities = new Proxy(["CAPABILITY_A"], {
      ownKeys: (target) => {
        capabilityProxyTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, key) => {
        capabilityProxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    const runtime = manager();
    runtime.register(definition("proxy-capabilities", "ready", {
      readiness: {
        kind: "CUSTOM_LOCAL",
        probe: () => ({
          ready: true,
          handshake: {
            componentVersion: "fixture-1",
            capabilities
          }
        })
      }
    }));

    await expect(runtime.start("proxy-capabilities"))
      .rejects.toMatchObject({ code: "READINESS_FAILED" });
    expect(capabilityProxyTraps).toBe(0);
  });

  it("handles hostile readiness callback values without executing proxy traps", async () => {
    const revokedDecision = Proxy.revocable({ ready: true }, {});
    revokedDecision.revoke();
    const returned = manager();
    returned.register(definition("revoked-decision", "ready", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 2, backoffMs: 5 },
      readiness: {
        kind: "CUSTOM_LOCAL",
        probe: () => revokedDecision.proxy as unknown as { readonly ready: boolean }
      }
    }));
    await expect(returned.start("revoked-decision"))
      .rejects.toMatchObject({ code: "READINESS_FAILED" });
    expect(returned.getStatus("revoked-decision").restartCount).toBe(0);

    let handshakeGetterCalls = 0;
    const accessorHandshake = Object.defineProperty({}, "componentVersion", {
      enumerable: true,
      get: () => {
        handshakeGetterCalls += 1;
        return "fixture-1";
      }
    });
    const accessor = manager();
    accessor.register(definition("accessor-handshake", "ready", {
      readiness: {
        kind: "CUSTOM_LOCAL",
        probe: () => ({
          ready: true,
          handshake: accessorHandshake as LocalComponentHandshake
        })
      }
    }));
    await expect(accessor.start("accessor-handshake"))
      .rejects.toMatchObject({ code: "READINESS_FAILED" });
    expect(handshakeGetterCalls).toBe(0);

    const revokedThrown = Proxy.revocable({}, {});
    revokedThrown.revoke();
    const throwing = manager();
    let throwingProbeCalls = 0;
    throwing.register(definition("revoked-thrown", "ready", {
      startupTimeoutMs: 300,
      readiness: {
        kind: "CUSTOM_LOCAL",
        intervalMs: 5,
        probe: () => {
          throwingProbeCalls += 1;
          throw revokedThrown.proxy;
        }
      }
    }));
    await expect(throwing.start("revoked-thrown"))
      .rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(throwingProbeCalls).toBeGreaterThan(0);
  });

  it("snapshots returned handshake state before queued caller mutation", async () => {
    const runtime = manager();
    const metadata = { note: "initial" };
    const handshake = {
      componentVersion: "fixture-1",
      protocolVersion: 1,
      metadata
    };

    runtime.register(definition("handshake-mutation", "line-ready", {
      expectedHandshake: {
        componentVersion: "fixture-1",
        protocolVersion: 1
      },
      readiness: {
        kind: "STDOUT_LINE",
        evaluate: (line) => {
          if (line !== "READY-LINE") return false;
          queueMicrotask(() => {
            handshake.componentVersion = "mutated-after-return";
            metadata.note = "mutated-after-return";
          });
          return { ready: true, handshake };
        }
      }
    }));

    const status = await runtime.start("handshake-mutation");
    await Promise.resolve();
    expect(handshake.componentVersion).toBe("mutated-after-return");
    expect(metadata.note).toBe("mutated-after-return");
    expect(status.handshake).toMatchObject({
      componentVersion: "fixture-1",
      protocolVersion: 1,
      metadata: { note: "initial" }
    });
  });

  it("does not let readiness callback exceptions spoof lifecycle error codes", async () => {
    const custom = manager();
    let customProbeCalls = 0;
    custom.register(definition("spoofed-custom-error", "ready", {
      startupTimeoutMs: 120,
      readiness: {
        kind: "CUSTOM_LOCAL",
        intervalMs: 5,
        probe: () => {
          customProbeCalls += 1;
          throw new LocalRuntimeError("START_CANCELLED", "spoofed cancellation");
        }
      }
    }));

    await expect(custom.start("spoofed-custom-error"))
      .rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(customProbeCalls).toBeGreaterThan(1);
    expect(custom.getStatus("spoofed-custom-error").state).toBe("FAILED");

    let httpEvaluateCalls = 0;
    const http = manager({
      fetch: () => Promise.resolve(new Response(null, { status: 204 }))
    });
    http.register(definition("spoofed-http-error", "ready", {
      startupTimeoutMs: 120,
      readiness: {
        kind: "HTTP_LOOPBACK",
        url: "http://127.0.0.1:43199/health",
        intervalMs: 5,
        evaluate: () => {
          httpEvaluateCalls += 1;
          throw new LocalRuntimeError("HANDSHAKE_MISMATCH", "spoofed mismatch");
        }
      }
    }));

    await expect(http.start("spoofed-http-error"))
      .rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(httpEvaluateCalls).toBeGreaterThan(1);
    expect(http.getStatus("spoofed-http-error").state).toBe("FAILED");

    let fetchCalls = 0;
    const fetchSpoof = manager({
      fetch: (() => {
        fetchCalls += 1;
        return Promise.reject(new LocalRuntimeError("READINESS_FAILED", "spoofed fetch failure"));
      }) as typeof globalThis.fetch
    });
    fetchSpoof.register(definition("spoofed-fetch-error", "ready", {
      startupTimeoutMs: 120,
      readiness: {
        kind: "HTTP_LOOPBACK",
        url: "http://127.0.0.1:43199/health",
        intervalMs: 5
      }
    }));

    await expect(fetchSpoof.start("spoofed-fetch-error"))
      .rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(fetchCalls).toBeGreaterThan(1);
  });

  it("rejects malformed reported handshake metadata", async () => {
    const runtime = manager();
    runtime.register(definition("bad-handshake-shape", "ready", {
      readiness: {
        kind: "CUSTOM_LOCAL",
        probe: () => ({
          ready: true,
          handshake: {
            protocolVersion: {} as unknown as number
          }
        })
      }
    }));

    await expect(runtime.start("bad-handshake-shape")).rejects.toMatchObject({ code: "READINESS_FAILED" });
  });

  it("does not execute proxy traps in arbitrary handshake metadata", async () => {
    let metadataProxyTraps = 0;
    const metadata = new Proxy({ note: "should-not-be-read" }, {
      ownKeys: (target) => {
        metadataProxyTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, key) => {
        metadataProxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf: (target) => {
        metadataProxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      }
    });
    const runtime = manager();
    runtime.register(definition("proxy-metadata", "ready", {
      readiness: {
        kind: "CUSTOM_LOCAL",
        probe: () => ({
          ready: true,
          handshake: {
            componentVersion: "fixture-1",
            metadata
          }
        })
      }
    }));

    const status = await runtime.start("proxy-metadata");
    expect(status.handshake?.metadata).toEqual({});
    expect(metadataProxyTraps).toBe(0);
  });

  it("does not cascade secret redaction across normalized handshake metadata", async () => {
    const runtime = manager();
    runtime.register(definition("metadata-marker-redaction", "ready", {
      environment: { secrets: { RUNTIME_ONLY_SECRET: "[" } },
      readiness: {
        kind: "CUSTOM_LOCAL",
        probe: () => ({
          ready: true,
          handshake: {
            componentVersion: "fixture-1",
            metadata: {
              "[": "["
            }
          }
        })
      }
    }));

    const status = await runtime.start("metadata-marker-redaction");
    expect(status.handshake?.metadata).toEqual({
      "[REDACTED]": "[REDACTED]"
    });
    expect(JSON.stringify(status.handshake?.metadata))
      .not.toContain("[REDACTED]REDACTED]");
  });

  it("redacts runtime secrets used as handshake metadata keys", async () => {
    const secret = "q7V9m2L4z8P6";
    const runtime = manager();
    runtime.register(definition("secret-metadata-key", "ready", {
      environment: { secrets: { RUNTIME_ONLY_SECRET: secret } },
      readiness: {
        kind: "CUSTOM_LOCAL",
        probe: () => ({
          ready: true,
          handshake: {
            componentVersion: "fixture-1",
            metadata: { [secret]: "diagnostic-value" }
          }
        })
      }
    }));

    const status = await runtime.start("secret-metadata-key");
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts long runtime secrets before handshake metadata truncation", async () => {
    const secret = "long-runtime-secret-" + "x".repeat(3_000);
    const runtime = manager();
    runtime.register(definition("long-secret-handshake", "ready", {
      environment: { secrets: { RUNTIME_ONLY_SECRET: secret } },
      readiness: {
        kind: "CUSTOM_LOCAL",
        probe: () => ({
          ready: true,
          handshake: {
            componentVersion: "fixture-1",
            metadata: { note: secret }
          }
        })
      }
    }));

    const status = await runtime.start("long-secret-handshake");
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(secret.slice(0, 500));
    expect(serialized).toContain("[REDACTED]");
  });

  it("does not report graceful stop for a root that already crashed", async () => {
    if (process.platform === "win32") return;

    const runtime = manager();
    let childPid: number | undefined;
    runtime.register(definition("dead-root-stop", "exit-with-stubborn-pipe-child", {
      terminationTimeoutMs: 80,
      restartPolicy: { mode: "NEVER" },
      readiness: {
        kind: "STDOUT_JSON",
        evaluate: (message) => {
          if (typeof message !== "object" || message === null) return false;
          const value = message as Record<string, unknown>;
          if (typeof value.childPid === "number") {
            childPid = value.childPid;
            fixturePids.push(value.childPid);
          }
          return readyDecision(message);
        }
      }
    }, ["20"]));

    await runtime.start("dead-root-stop");
    await waitForStatus(runtime, "dead-root-stop", (status) =>
      status.state === "FAILED" && status.lastExit?.code === 18
    );

    const stopped = await runtime.stop("dead-root-stop");
    expect(stopped.disposition).not.toBe("GRACEFUL");
    expect(runtime.getStatus("dead-root-stop").state).toBe("STOPPED");
    if (childPid !== undefined) await waitForPidExit(childPid);
  });

  it("observes parent process exit even while a descendant keeps inherited pipes open", async () => {
    const runtime = manager();
    let childPid: number | undefined;
    runtime.register(definition("pipe-exit", "exit-with-pipe-child", {
      terminationTimeoutMs: 500,
      readiness: {
        kind: "STDOUT_JSON",
        evaluate: (message) => {
          if (typeof message !== "object" || message === null) return false;
          const value = message as Record<string, unknown>;
          if (typeof value.childPid === "number") {
            childPid = value.childPid;
            fixturePids.push(value.childPid);
          }
          return readyDecision(message);
        }
      }
    }, ["500"]));
    await runtime.start("pipe-exit");

    await waitForStatus(runtime, "pipe-exit", (status) =>
      status.state === "FAILED" && status.lastExit?.code === 15
    );
    expect(childPid).toBeTypeOf("number");
    await runtime.stop("pipe-exit");
    if (childPid !== undefined) await waitForPidExit(childPid);
  });

  it("rejects impossible and excessively large output/readiness configurations", () => {
    const runtime = manager();
    expect(() => runtime.register(definition("stable-too-long", "ready", {
      startupTimeoutMs: 50,
      readiness: { kind: "STABLE_PROCESS", stableMs: 100 }
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register(definition("too-many-lines", "ready", {
      output: { maxLines: 10_001 }
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register(definition("too-many-bytes", "ready", {
      output: { maxBytes: 4 * 1024 * 1024 + 1 }
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register({
      ...definition("bad-hook", "ready"),
      gracefulShutdown: "not-a-function" as unknown as LocalComponentDefinition["gracefulShutdown"]
    })).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register(null as unknown as LocalComponentDefinition))
      .toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
  });

  it("keeps lifecycle timestamps available when an injected diagnostic clock is invalid", async () => {
    const runtime = manager({ now: () => new Date(Number.NaN) });
    runtime.register(definition("invalid-clock", "ready"));
    const status = await runtime.start("invalid-clock");
    expect(() => new Date(status.startedAt ?? "").toISOString()).not.toThrow();
  });


  it("rejects accessor-backed and oversized environment configuration without invoking getters", () => {
    let topLevelGetterCalls = 0;
    const topLevel = Object.defineProperty({}, "values", {
      enumerable: true,
      get: () => {
        topLevelGetterCalls += 1;
        return { SAFE_VALUE: "unexpected" };
      }
    });
    expect(() => buildLocalEnvironment(
      topLevel as Parameters<typeof buildLocalEnvironment>[0],
      {}
    )).toThrow(/accessor/u);
    expect(topLevelGetterCalls).toBe(0);

    let nestedGetterCalls = 0;
    const nestedValues = Object.defineProperty({}, "SAFE_VALUE", {
      enumerable: true,
      get: () => {
        nestedGetterCalls += 1;
        return "unexpected";
      }
    });
    expect(() => buildLocalEnvironment({
      values: nestedValues as Readonly<Record<string, string>>
    }, {})).toThrow(/accessor/u);
    expect(nestedGetterCalls).toBe(0);

    let inheritGetterCalls = 0;
    const inheritedKeys = ["PATH"];
    Object.defineProperty(inheritedKeys, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        inheritGetterCalls += 1;
        return "PATH";
      }
    });
    expect(() => buildLocalEnvironment({ inherit: inheritedKeys }, { PATH: "safe" }))
      .toThrow(/data-only array/iu);
    expect(inheritGetterCalls).toBe(0);

    let environmentKeyCoercions = 0;
    const coerciveKey = {
      toString: () => {
        environmentKeyCoercions += 1;
        return "PATH";
      }
    };
    expect(() => buildLocalEnvironment({
      inherit: [coerciveKey] as unknown as readonly string[]
    }, { PATH: "safe" })).toThrow(/expected a string/iu);
    expect(environmentKeyCoercions).toBe(0);

    let directParentProxyTraps = 0;
    const directParentProxy = new Proxy({ PATH: "safe" }, {
      ownKeys: (target) => {
        directParentProxyTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, key) => {
        directParentProxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    expect(() => buildLocalEnvironment(undefined, directParentProxy))
      .toThrow(/Parent environment could not be inspected/iu);
    expect(directParentProxyTraps).toBe(0);

    let parentGetterCalls = 0;
    const parent = Object.defineProperty({}, "PATH", {
      enumerable: true,
      get: () => {
        parentGetterCalls += 1;
        return "untrusted-path";
      }
    });
    expect(() => buildLocalEnvironment(
      undefined,
      parent as NodeJS.ProcessEnv,
      process.platform
    )).toThrow(/may not contain accessors/iu);
    expect(parentGetterCalls).toBe(0);

    expect(() => buildLocalEnvironment(
      { unexpected: "value" } as unknown as Parameters<typeof buildLocalEnvironment>[0],
      {}
    )).toThrow(/unknown environment definition field/iu);

    expect(() => buildLocalEnvironment(
      new Date() as unknown as Parameters<typeof buildLocalEnvironment>[0],
      {}
    )).toThrow(/plain data object/iu);
    expect(() => buildLocalEnvironment({
      values: new Map() as unknown as Readonly<Record<string, string>>
    }, {})).toThrow(/plain data object/iu);
    expect(() => buildLocalEnvironment({
      secrets: new Date() as unknown as Readonly<Record<string, string>>
    }, {})).toThrow(/plain data object/iu);

    const hiddenParent = Object.defineProperty({}, "SAFE_PARENT", {
      enumerable: false,
      value: "hidden-parent-value"
    });
    const hiddenInherited = buildLocalEnvironment(
      { inherit: ["SAFE_PARENT"] },
      hiddenParent as NodeJS.ProcessEnv
    );
    expect(hiddenInherited.environment).not.toHaveProperty("SAFE_PARENT");

    const tooManyValues = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`VALUE_${String(index)}`, "x"])
    );
    expect(() => buildLocalEnvironment({ values: tooManyValues }, {}))
      .toThrow(/at most 256/iu);

    const tooManySecretLines = Array.from(
      { length: 257 },
      (_, index) => `secret-line-${String(index)}`
    ).join("\n");
    expect(() => buildLocalEnvironment({
      secrets: { MULTILINE_SECRET: tooManySecretLines }
    }, {})).toThrow(/at most 256 physical lines/iu);

    const mutableValues = { SNAPSHOT_VALUE: "snapshot-source" };
    const snapshotted = buildLocalEnvironment({ values: mutableValues }, {});
    mutableValues.SNAPSHOT_VALUE = "mutated-after-validation";
    expect(snapshotted.environment.SNAPSHOT_VALUE).toBe("snapshot-source");
  });

  it("treats explicit secret-looking environment values as diagnostic secrets", () => {
    const secret = "explicit-api-key-private-314159";
    const built = buildLocalEnvironment({
      values: {
        SAFE_VALUE: "visible",
        MODEL_API_KEY: secret
      }
    }, {});

    expect(built.environment.SAFE_VALUE).toBe("visible");
    expect(built.environment.MODEL_API_KEY).toBe(secret);
    expect(built.secretValues).toContain(secret);
  });

  it("does not spend redaction budget on inherited secrets that are overridden", () => {
    const staleInheritedSecret = Array.from(
      { length: 257 },
      (_, index) => `stale-secret-line-${String(index)}`
    ).join("\n");

    const built = buildLocalEnvironment({
      inherit: ["API_TOKEN"],
      values: { API_TOKEN: "replacement-token-value" }
    }, {
      API_TOKEN: staleInheritedSecret
    });

    expect(built.environment.API_TOKEN).toBe("replacement-token-value");
    expect(built.secretValues).toContain("replacement-token-value");
    expect(built.secretValues.some((value) => value.includes("stale-secret-line"))).toBe(false);
  });

  it("prefers longer overlapping secrets even when inputs are unsorted", () => {
    expect(redactKnownSecrets("abcd", ["ab", "abcd"]))
      .toBe("[REDACTED]");
    expect(redactKnownSecrets("x.a+b?y", [".", "a+b?", "x.a+b?"]))
      .toBe("[REDACTED]y");
    expect(redactKnownSecrets("line-one\nline-two", ["line-two", "line-one\nline-two"]))
      .toBe("[REDACTED]");
  });

  it("redacts repeated and overlapping secret matches without cascading", () => {
    expect(redactKnownSecrets("aaaa", ["a", "["])).toBe("[REDACTED]");
    expect(redactKnownSecrets("xaaab", ["xa", "aa"])).toBe("[REDACTED]b");
    expect(redactKnownSecrets("[abcdef", ["abcdef", "abc", "["]))
      .toBe("[REDACTED]");
  });

  it("retains the newest bounded output through repeated eviction", () => {
    const buffer = new BoundedLineBuffer(3, 128, []);
    for (let index = 0; index < 5_000; index += 1) {
      buffer.push(`line-${String(index)}`);
    }

    const snapshot = buffer.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.lines).toEqual([
      "[TRUNCATED]",
      "line-4998",
      "line-4999"
    ]);
  });

  it("reassembles a heavily fragmented bounded output line", () => {
    const lines: string[] = [];
    let malformed = 0;
    const framer = new BoundedLineFramer(
      4_096,
      (line) => lines.push(line),
      () => {
        malformed += 1;
      }
    );
    const first = "x".repeat(2_048);
    const bytes = Buffer.from(`${first}\nREADY-LINE\n`, "utf8");

    for (const byte of bytes) framer.append(Buffer.from([byte]));

    expect(malformed).toBe(0);
    expect(lines).toEqual([first, "READY-LINE"]);
  });

  it("accepts a max-sized CRLF line when the terminator is fragmented", () => {
    const lines: string[] = [];
    let malformed = 0;
    const framer = new BoundedLineFramer(
      4,
      (line) => lines.push(line),
      () => {
        malformed += 1;
      }
    );

    framer.append(Buffer.from("abcd\r", "utf8"));
    framer.append(Buffer.from("\n", "utf8"));

    expect(lines).toEqual(["abcd"]);
    expect(malformed).toBe(0);
  });

  it("recovers framing after invalid UTF-8 and accepts CRLF readiness lines", async () => {
    const runtime = manager();
    runtime.register(definition("invalid-utf8", "invalid-utf8-then-ready", {
      environment: { secrets: { RUNTIME_ONLY_SECRET: "[" } }
    }));
    const invalidUtf8 = await runtime.start("invalid-utf8");
    expect(invalidUtf8.state).toBe("READY");
    expect(invalidUtf8.stdout.lines).toContain("[MALFORMED_OUTPUT]");

    runtime.register(definition("crlf", "crlf-line-ready", {
      readiness: {
        kind: "STDOUT_LINE",
        evaluate: (line) => line === "READY-LINE"
      }
    }));
    await expect(runtime.start("crlf")).resolves.toMatchObject({ state: "READY" });
  });

  it("rejects revoked proxy definitions and environment objects predictably", () => {
    const runtime = manager();
    let definitionProxyTraps = 0;
    const liveDefinitionProxy = new Proxy(definition("live-proxy-definition", "ready"), {
      ownKeys: (target) => {
        definitionProxyTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, key) => {
        definitionProxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf: (target) => {
        definitionProxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      }
    });
    expect(() => runtime.register(liveDefinitionProxy))
      .toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
    expect(definitionProxyTraps).toBe(0);

    const definitionProxy = Proxy.revocable(definition("revoked-definition", "ready"), {});
    definitionProxy.revoke();
    expect(() => runtime.register(definitionProxy.proxy))
      .toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    let environmentProxyTraps = 0;
    const liveEnvironmentValues = new Proxy({ SAFE_VALUE: "x" }, {
      ownKeys: (target) => {
        environmentProxyTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, key) => {
        environmentProxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    expect(() => buildLocalEnvironment({
      values: liveEnvironmentValues
    }, {})).toThrow(/could not be inspected/iu);
    expect(environmentProxyTraps).toBe(0);

    const environmentProxy = Proxy.revocable({ values: { SAFE_VALUE: "x" } }, {});
    environmentProxy.revoke();
    expect(() => buildLocalEnvironment(
      environmentProxy.proxy as Parameters<typeof buildLocalEnvironment>[0],
      {}
    )).toThrow(/could not be inspected/iu);
  });

  it("never executes accessors while inspecting process definitions", () => {
    const runtime = manager();
    let getterCalls = 0;

    const topLevel = Object.defineProperty(
      {
        id: "accessor-top",
        args: [FIXTURE, "ready"],
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 200,
        readiness: {
          kind: "STDOUT_JSON",
          evaluate: (message: unknown) => readyDecision(message)
        }
      },
      "executable",
      {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return process.execPath;
        }
      }
    ) as unknown as LocalComponentDefinition;

    expect(() => runtime.register(topLevel))
      .toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
    expect(getterCalls).toBe(0);

    const hostileArgs = [FIXTURE, "ready"];
    Object.defineProperty(hostileArgs, "1", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return "crash";
      }
    });
    expect(() => runtime.register({
      ...definition("accessor-args", "ready"),
      args: hostileArgs
    })).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
    expect(getterCalls).toBe(0);

    const hostileReadiness = Object.defineProperty({}, "kind", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "STABLE_PROCESS";
      }
    }) as LocalComponentDefinition["readiness"];
    expect(() => runtime.register({
      ...definition("accessor-readiness", "ready"),
      readiness: hostileReadiness
    })).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
    expect(getterCalls).toBe(0);
  });

  it("does not execute proxy traps while reporting shutdown failures", async () => {
    let shutdownErrorProxyTraps = 0;
    const proxiedError = new Proxy(new Error("hidden"), {
      getOwnPropertyDescriptor: (target, key) => {
        shutdownErrorProxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf: (target) => {
        shutdownErrorProxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      }
    });
    const runtime = manager();
    runtime.register(definition("proxy-hook-error", "ignore-shutdown", {
      shutdownTimeoutMs: 30,
      terminationTimeoutMs: 150,
      gracefulShutdown: () => {
        throw proxiedError;
      }
    }));

    await runtime.start("proxy-hook-error");
    await runtime.stop("proxy-hook-error");
    expect(shutdownErrorProxyTraps).toBe(0);
    expect(runtime.getStatus("proxy-hook-error").failure).toMatchObject({
      code: "GRACEFUL_SHUTDOWN_FAILED",
      message: expect.stringContaining("unknown error")
    });
  });

  it("does not invoke hostile error message accessors while reporting shutdown failures", async () => {
    const runtime = manager();
    let messageGetterCalls = 0;
    const hostileError = new Error("initial");
    Object.defineProperty(hostileError, "message", {
      configurable: true,
      get: () => {
        messageGetterCalls += 1;
        throw new Error("message getter must not run");
      }
    });

    runtime.register(definition("hostile-hook-error", "ignore-shutdown", {
      shutdownTimeoutMs: 30,
      terminationTimeoutMs: 150,
      gracefulShutdown: () => {
        throw hostileError;
      }
    }));
    await runtime.start("hostile-hook-error");
    await runtime.stop("hostile-hook-error");

    expect(messageGetterCalls).toBe(0);
    expect(runtime.getStatus("hostile-hook-error").failure).toMatchObject({
      code: "GRACEFUL_SHUTDOWN_FAILED"
    });
    expect(runtime.getStatus("hostile-hook-error").failure?.message)
      .toContain("unknown error");
  });

  it("does not expose direct process signaling through graceful shutdown controls", async () => {
    const runtime = manager();
    let signalExposed = true;
    let invalidWrite: unknown;
    let coercions = 0;
    const hostileData = {
      toString: () => {
        coercions += 1;
        return "shutdown-now\n";
      }
    };
    runtime.register(definition("graceful-control", "stdin-shutdown", {
      gracefulShutdown: async (control) => {
        signalExposed = Object.hasOwn(control, "signal");
        try {
          await control.writeStdin(hostileData as unknown as string);
        } catch (error) {
          invalidWrite = error;
        }
        await control.writeStdin("shutdown-now\n");
      }
    }));

    await runtime.start("graceful-control");
    await runtime.stop("graceful-control");
    expect(signalExposed).toBe(false);
    expect(invalidWrite).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(coercions).toBe(0);
  });

  it("rejects fields that are invalid for a selected lifecycle mode", () => {
    const runtime = manager();

    expect(() => runtime.register(definition("stable-with-url", "ready", {
      readiness: {
        kind: "STABLE_PROCESS",
        stableMs: 20,
        url: "http://127.0.0.1:43199/health"
      } as unknown as LocalComponentDefinition["readiness"]
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register(definition("stdout-with-interval", "ready", {
      readiness: {
        kind: "STDOUT_LINE",
        evaluate: () => true,
        intervalMs: 10
      } as unknown as LocalComponentDefinition["readiness"]
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register(definition("never-with-retries", "ready", {
      restartPolicy: {
        mode: "NEVER",
        maxRetries: 1
      } as unknown as LocalComponentDefinition["restartPolicy"]
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
  });

  it("rejects contradictory output bounds and effectively unbounded retry counts", () => {
    const runtime = manager();

    expect(() => runtime.register(definition("contradictory-output", "ready", {
      output: { maxBytes: 128, maxLineBytes: 129 }
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register(definition("line-over-default-budget", "ready", {
      output: { maxLineBytes: 128 * 1024 }
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register(definition("too-many-retries", "ready", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 101 }
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

    expect(() => runtime.register(definition("bounded-retries", "ready", {
      restartPolicy: { mode: "ON_FAILURE", maxRetries: 100 },
      output: { maxBytes: 128 }
    }))).not.toThrow();

    expect(() => runtime.register(definition("oversized-expected-version", "ready", {
      expectedHandshake: { componentVersion: "x".repeat(2_001) }
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));
    expect(() => runtime.register(definition("implicit-backoff-cap", "ready", {
      restartPolicy: {
        mode: "ON_FAILURE",
        maxRetries: 1,
        maxBackoffMs: 99
      }
    }))).toThrow(expect.objectContaining({ code: "INVALID_DEFINITION" }));

  });
});


async function waitForStatus(
  runtime: LocalRuntimeManager,
  componentId: string,
  predicate: (status: ReturnType<LocalRuntimeManager["getStatus"]>) => boolean
): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    if (predicate(runtime.getStatus(componentId))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(runtime.getStatus(componentId))).toBe(true);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (isPidAlive(pid) && performance.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(isPidAlive(pid)).toBe(false);
  for (let index = fixturePids.length - 1; index >= 0; index -= 1) {
    if (fixturePids[index] === pid) fixturePids.splice(index, 1);
  }
}
