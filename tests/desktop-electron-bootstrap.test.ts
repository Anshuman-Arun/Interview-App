import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_AUTH_HEADER_VALUE,
  createDesktopRendererBootstrap,
  isAuthorizedDesktopBootstrapRequest,
  isTrustedDesktopNavigation,
  validateDesktopRendererBootstrap
} from "../apps/desktop/src/bootstrap.js";
import {
  DesktopBackendController,
  type InterviewServerFactory,
  type InterviewServerInstance
} from "../apps/desktop/src/backend-controller.js";
import {
  installDesktopClientTokenInjector,
  type BeforeSendHeadersCallback,
  type BeforeSendHeadersDetails,
  type WebRequestHeaderBoundary
} from "../apps/desktop/src/client-token-injector.js";
import { DesktopFrontendServer } from "../apps/desktop/src/frontend-server.js";
import { tryDesktopCleanup } from "../apps/desktop/src/lifecycle-cleanup.js";
import { resolveDesktopMode, resolveDevelopmentFrontendOrigin } from "../apps/desktop/src/mode.js";
import { resolveDesktopPaths } from "../apps/desktop/src/paths.js";
import { createSecureWebPreferences } from "../apps/desktop/src/window-config.js";

type HeaderListener = (
  details: BeforeSendHeadersDetails,
  callback: BeforeSendHeadersCallback
) => void;

const TRUSTED_MAIN_FRAME = {};

class FakeWebRequest implements WebRequestHeaderBoundary {
  public listener: HeaderListener | undefined;
  public throwAfterInstall = false;
  public clearCalls = 0;

  public onBeforeSendHeaders(
    filter: { readonly urls: readonly string[] },
    listener: HeaderListener
  ): void;
  public onBeforeSendHeaders(listener: null): void;
  public onBeforeSendHeaders(
    filterOrListener: { readonly urls: readonly string[] } | null,
    listener?: HeaderListener
  ): void {
    if (filterOrListener === null) {
      this.clearCalls += 1;
      this.listener = undefined;
      return;
    }
    this.listener = listener;
    if (this.throwAfterInstall) {
      this.throwAfterInstall = false;
      throw new Error("registration failed after side effect");
    }
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("desktop secure bootstrap", () => {
  it("uses secure Electron webPreferences", () => {
    expect(createSecureWebPreferences("/trusted/preload.cjs")).toEqual({
      preload: "/trusted/preload.cjs",
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      partition: "interview-desktop"
    });

    expect(() => createSecureWebPreferences("relative/preload.cjs"))
      .toThrow(/absolute filesystem path/u);
    expect(() => createSecureWebPreferences(""))
      .toThrow(/absolute filesystem path/u);
    expect(() => createSecureWebPreferences(123 as never))
      .toThrow(/absolute filesystem path/u);
  });

  it("authorizes desktop bootstrap only for the trusted main frame and origin", () => {
    const mainFrame = {};
    const subFrame = {};
    const base = {
      shuttingDown: false,
      senderWebContentsId: 7,
      trustedWebContentsId: 7,
      senderFrame: mainFrame,
      trustedMainFrame: mainFrame,
      senderFrameUrl: "http://127.0.0.1:5173/interview",
      trustedFrontendUrl: "http://127.0.0.1:5173"
    };

    expect(isAuthorizedDesktopBootstrapRequest(base)).toBe(true);
    expect(isAuthorizedDesktopBootstrapRequest({ ...base, shuttingDown: true })).toBe(false);
    expect(isAuthorizedDesktopBootstrapRequest({ ...base, senderWebContentsId: 8 })).toBe(false);
    expect(isAuthorizedDesktopBootstrapRequest({ ...base, senderFrame: subFrame })).toBe(false);
    expect(isAuthorizedDesktopBootstrapRequest({
      ...base,
      senderFrameUrl: "http://127.0.0.1:5174/interview"
    })).toBe(false);
    expect(isAuthorizedDesktopBootstrapRequest({
      ...base,
      senderFrame: null,
      senderFrameUrl: undefined
    })).toBe(false);
  });

  it("allows only same-origin desktop navigation and redirects", () => {
    const trusted = "http://127.0.0.1:5173/interview";
    expect(isTrustedDesktopNavigation("http://127.0.0.1:5173/other", trusted)).toBe(true);
    expect(isTrustedDesktopNavigation("http://127.0.0.1:5173/?route=1", trusted)).toBe(true);

    for (const candidate of [
      "https://127.0.0.1:5173/",
      "http://localhost:5173/",
      "http://127.0.0.1:5174/",
      "https://attacker.invalid/",
      "not a url"
    ]) {
      expect(isTrustedDesktopNavigation(candidate, trusted)).toBe(false);
    }
    expect(isTrustedDesktopNavigation(
      "http://127.0.0.1:5173/",
      "https://attacker.invalid/"
    )).toBe(false);
  });

  it("exposes only safe connection metadata and no client token", () => {
    const clientToken = "secret-token-value-that-must-never-enter-bootstrap";
    const bootstrap = createDesktopRendererBootstrap({
      commandBaseUrl: "http://127.0.0.1:41000",
      rendererStreamUrl: "http://127.0.0.1:41001/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41002",
      appVersion: "1.0.0",
      platform: "test"
    });
    expect(JSON.stringify(bootstrap)).not.toContain(clientToken);
    expect(JSON.stringify(bootstrap)).not.toMatch(/clientToken|INTERVIEW_CLIENT_TOKEN/u);
    expect(bootstrap.authentication.headerValue).toBe(DESKTOP_AUTH_HEADER_VALUE);
  });

  it("fails closed on malformed or non-loopback bootstrap data", () => {
    expect(() => validateDesktopRendererBootstrap({
      protocolVersion: 1,
      commandBaseUrl: "https://example.com",
      rendererStreamUrl: "http://127.0.0.1:41001/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41002",
      authentication: { mode: "DESKTOP_MANAGED", headerValue: DESKTOP_AUTH_HEADER_VALUE },
      appVersion: "1",
      platform: "test"
    })).toThrow();
    expect(() => validateDesktopRendererBootstrap({
      protocolVersion: 1,
      commandBaseUrl: "http://127.0.0.1:41000?token=bad",
      rendererStreamUrl: "http://127.0.0.1:41001/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41002",
      authentication: { mode: "DESKTOP_MANAGED", headerValue: DESKTOP_AUTH_HEADER_VALUE },
      appVersion: "1",
      platform: "test"
    })).toThrow();
  });

  it("rejects bootstrap payloads with extra privileged or ambiguous fields", () => {
    const valid = createDesktopRendererBootstrap({
      commandBaseUrl: "http://127.0.0.1:41000",
      rendererStreamUrl: "http://127.0.0.1:41001/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41002",
      appVersion: "1.0.0",
      platform: "test"
    });

    expect(() => validateDesktopRendererBootstrap({
      ...valid,
      clientToken: "must-never-be-accepted"
    })).toThrow(/malformed/u);

    expect(() => validateDesktopRendererBootstrap({
      ...valid,
      databasePath: "/private/interview.sqlite"
    })).toThrow(/malformed/u);

    expect(() => validateDesktopRendererBootstrap({
      ...valid,
      authentication: {
        ...valid.authentication,
        clientToken: "must-never-be-accepted"
      }
    })).toThrow(/malformed/u);
  });

  it("rejects unsupported backend configuration keys before factory invocation", () => {
    const factory = vi.fn(async () => ({
      stop: vi.fn(async () => undefined)
    })) as unknown as InterviewServerFactory;
    const controller = new DesktopBackendController(factory);

    expect(() => controller.start({
      clientToken: "x".repeat(32),
      futureSecurityOption: true
    } as never)).toThrow(/unsupported field "futureSecurityOption"/u);
    expect(factory).not.toHaveBeenCalled();
    expect(controller.started).toBe(false);
  });

  it("prevents duplicate backend starts and waits for readiness", async () => {
    let resolveStart: ((value: InterviewServerInstance) => void) | undefined;
    const stop = vi.fn(async () => undefined);
    const factory = vi.fn(() => new Promise<InterviewServerInstance>((resolve) => {
      resolveStart = resolve;
    })) as unknown as InterviewServerFactory;
    const controller = new DesktopBackendController(factory);
    const first = controller.start({ clientToken: "x".repeat(32) });
    const second = controller.start({ clientToken: "x".repeat(32) });
    expect(factory).toHaveBeenCalledTimes(1);

    const instance = { stop } as unknown as InterviewServerInstance;
    resolveStart?.(instance);
    await expect(first).resolves.toBe(instance);
    await expect(second).resolves.toBe(instance);
    await controller.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting concurrent and already-started backend configurations", async () => {
    let resolveStart: ((value: InterviewServerInstance) => void) | undefined;
    const stop = vi.fn(async () => undefined);
    const factory = vi.fn(() => new Promise<InterviewServerInstance>((resolve) => {
      resolveStart = resolve;
    })) as unknown as InterviewServerFactory;
    const controller = new DesktopBackendController(factory);
    const config = {
      clientToken: "x".repeat(32),
      databasePath: "/stable/interview.sqlite",
      allowedOrigins: ["http://127.0.0.1:5173", "http://127.0.0.1:3000"]
    } as const;

    const first = controller.start(config);
    expect(() => controller.start({
      ...config,
      databasePath: "/different/interview.sqlite"
    })).toThrow(/different configuration/u);

    const instance = { stop } as unknown as InterviewServerInstance;
    resolveStart?.(instance);
    await expect(first).resolves.toBe(instance);

    expect(() => controller.start({
      ...config,
      clientToken: "y".repeat(32)
    })).toThrow(/different configuration/u);
    expect(factory).toHaveBeenCalledTimes(1);
    await controller.stop();
  });

  it("treats reordered duplicate origin sets as the same backend configuration", async () => {
    const stop = vi.fn(async () => undefined);
    const instance = { stop } as unknown as InterviewServerInstance;
    const factory = vi.fn(async () => instance) as unknown as InterviewServerFactory;
    const controller = new DesktopBackendController(factory);

    const first = await controller.start({
      clientToken: "x".repeat(32),
      allowedOrigins: ["http://127.0.0.1:5173", "http://127.0.0.1:3000"]
    });
    const second = await controller.start({
      clientToken: "x".repeat(32),
      allowedOrigins: [
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5173"
      ]
    });

    expect(first).toBe(instance);
    expect(second).toBe(instance);
    expect(factory).toHaveBeenCalledTimes(1);
    await controller.stop();
  });

  it("snapshots mutable configuration before asynchronous startup", async () => {
    let resolveStart: ((value: InterviewServerInstance) => void) | undefined;
    let receivedConfig: Parameters<InterviewServerFactory>[0] | undefined;
    const stop = vi.fn(async () => undefined);
    const factory = vi.fn((config: Parameters<InterviewServerFactory>[0]) => {
      receivedConfig = config;
      return new Promise<InterviewServerInstance>((resolve) => {
        resolveStart = resolve;
      });
    }) as unknown as InterviewServerFactory;
    const controller = new DesktopBackendController(factory);
    const origins = ["http://127.0.0.1:5173"];
    const config = {
      clientToken: "x".repeat(32),
      allowedOrigins: origins
    };

    const starting = controller.start(config);
    origins.push("https://attacker.invalid");
    expect(receivedConfig?.allowedOrigins).toEqual(["http://127.0.0.1:5173"]);

    resolveStart?.({ stop } as unknown as InterviewServerInstance);
    await starting;
    await controller.stop();
  });

  it("clears failed startup state so a later explicit retry can succeed", async () => {
    const stop = vi.fn(async () => undefined);
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error("port unavailable"))
      .mockResolvedValueOnce({ stop }) as unknown as InterviewServerFactory;
    const controller = new DesktopBackendController(factory);
    await expect(controller.start({})).rejects.toThrow("port unavailable");
    await expect(controller.start({})).resolves.toBeDefined();
    expect(factory).toHaveBeenCalledTimes(2);
    await controller.stop();
  });

  it("waits for an in-flight start before clean shutdown", async () => {
    let resolveStart: ((value: InterviewServerInstance) => void) | undefined;
    const stop = vi.fn(async () => undefined);
    const factory = (() => new Promise<InterviewServerInstance>((resolve) => {
      resolveStart = resolve;
    })) as InterviewServerFactory;
    const controller = new DesktopBackendController(factory);
    void controller.start({});
    const stopping = controller.stop();
    expect(stop).not.toHaveBeenCalled();
    resolveStart?.({ stop } as unknown as InterviewServerInstance);
    await stopping;
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed shutdown retryable and blocks unsafe restart", async () => {
    let stopAttempts = 0;
    const instance = {
      stop: vi.fn(async () => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error("close failed");
      })
    } as unknown as InterviewServerInstance;
    const factory = vi.fn(async () => instance) as unknown as InterviewServerFactory;
    const controller = new DesktopBackendController(factory);

    await controller.start({ clientToken: "x".repeat(32) });
    await expect(controller.stop()).rejects.toThrow("close failed");
    expect(controller.started).toBe(true);
    await expect(controller.start({ clientToken: "x".repeat(32) }))
      .rejects.toThrow(/failed shutdown/u);

    await expect(controller.stop()).resolves.toBeUndefined();
    expect(controller.started).toBe(false);
    await expect(controller.start({ clientToken: "x".repeat(32) })).resolves.toBe(instance);
    expect(factory).toHaveBeenCalledTimes(2);
    await controller.stop();
  });

  it("replaces only the desktop marker on exact endpoints for the exact renderer", () => {
    const webRequest = new FakeWebRequest();
    const secret = "s".repeat(64);
    const cleanup = installDesktopClientTokenInjector(webRequest, {
      commandUrl: "http://127.0.0.1:41100/v1/commands",
      rendererStreamUrl: "http://127.0.0.1:41101/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41102",
      clientToken: secret,
      webContentsId: 42,
      getTrustedMainFrame: () => TRUSTED_MAIN_FRAME
    });

    let output: Record<string, string | string[]> | undefined;
    webRequest.listener?.({
      url: "http://127.0.0.1:41100/v1/commands",
      method: "POST",
      webContentsId: 42,
      frame: TRUSTED_MAIN_FRAME,
      requestHeaders: { "x-interview-client-token": DESKTOP_AUTH_HEADER_VALUE }
    }, (result) => { output = result.requestHeaders; });
    expect(output?.["x-interview-client-token"]).toBe(secret);

    for (const url of [
      "http://127.0.0.1:41100/v1/read/sessions",
      "http://127.0.0.1:41100/v1/read/sessions/session_desktop/evaluation",
      "http://127.0.0.1:41100/v1/read/sessions/session_desktop/replay"
    ]) {
      webRequest.listener?.({
        url,
        method: "GET",
        webContentsId: 42,
        frame: TRUSTED_MAIN_FRAME,
        requestHeaders: { "x-interview-client-token": DESKTOP_AUTH_HEADER_VALUE }
      }, (result) => { output = result.requestHeaders; });
      expect(output?.["x-interview-client-token"]).toBe(secret);
    }

    for (const url of [
      "http://127.0.0.1:41100/v1/read/sessions/session_desktop/evaluation?leak=1",
      "http://127.0.0.1:41100/v1/read/sessions/session%2Fescape/replay",
      "http://127.0.0.1:41100/v1/read/other"
    ]) {
      webRequest.listener?.({
        url,
        method: "GET",
        webContentsId: 42,
        frame: TRUSTED_MAIN_FRAME,
        requestHeaders: { "x-interview-client-token": DESKTOP_AUTH_HEADER_VALUE }
      }, (result) => { output = result.requestHeaders; });
      expect(output?.["x-interview-client-token"]).toBe(DESKTOP_AUTH_HEADER_VALUE);
    }

    const subFrameHeaders = { "x-interview-client-token": DESKTOP_AUTH_HEADER_VALUE };
    webRequest.listener?.({
      url: "http://127.0.0.1:41100/v1/commands",
      method: "POST",
      webContentsId: 42,
      frame: {},
      requestHeaders: subFrameHeaders
    }, (result) => { output = result.requestHeaders; });
    expect(output).toEqual(subFrameHeaders);
    expect(JSON.stringify(output)).not.toContain(secret);

    webRequest.listener?.({
      url: "http://127.0.0.1:41100/other",
      method: "POST",
      webContentsId: 42,
      frame: TRUSTED_MAIN_FRAME,
      requestHeaders: { "x-interview-client-token": DESKTOP_AUTH_HEADER_VALUE }
    }, (result) => { output = result.requestHeaders; });
    expect(output?.["x-interview-client-token"]).toBe(DESKTOP_AUTH_HEADER_VALUE);

    cleanup();
    expect(webRequest.listener).toBeUndefined();
  });

  it("resolves the current main frame per request and fails closed if lookup breaks", () => {
    const webRequest = new FakeWebRequest();
    const secret = "s".repeat(64);
    const firstFrame = {};
    const secondFrame = {};
    let currentFrame: object | null = firstFrame;
    let throwLookup = false;
    installDesktopClientTokenInjector(webRequest, {
      commandUrl: "http://127.0.0.1:41100/v1/commands",
      rendererStreamUrl: "http://127.0.0.1:41101/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41102",
      clientToken: secret,
      webContentsId: 42,
      getTrustedMainFrame: () => {
        if (throwLookup) throw new Error("frame lookup failed");
        return currentFrame;
      }
    });

    const send = (frame: object): string | string[] | undefined => {
      let headers: Record<string, string | string[]> | undefined;
      webRequest.listener?.({
        url: "http://127.0.0.1:41100/v1/commands",
        method: "POST",
        webContentsId: 42,
        frame,
        requestHeaders: { "x-interview-client-token": DESKTOP_AUTH_HEADER_VALUE }
      }, (result) => { headers = result.requestHeaders; });
      return headers?.["x-interview-client-token"];
    };

    expect(send(firstFrame)).toBe(secret);
    currentFrame = secondFrame;
    expect(send(firstFrame)).toBe(DESKTOP_AUTH_HEADER_VALUE);
    expect(send(secondFrame)).toBe(secret);

    currentFrame = null;
    expect(send(secondFrame)).toBe(DESKTOP_AUTH_HEADER_VALUE);
    currentFrame = secondFrame;
    throwLookup = true;
    expect(send(secondFrame)).toBe(DESKTOP_AUTH_HEADER_VALUE);
  });

  it("contains one cleanup failure without skipping later independent cleanup", () => {
    const calls: string[] = [];
    const failed = tryDesktopCleanup(() => {
      calls.push("permission");
      throw new Error("permission cleanup failed");
    });
    const succeeded = tryDesktopCleanup(() => {
      calls.push("token");
    });

    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toBeInstanceOf(Error);
    expect(succeeded).toEqual({ ok: true });
    expect(calls).toEqual(["permission", "token"]);
  });

  it("rolls back token injector registration failures and makes cleanup idempotent", () => {
    const secret = "s".repeat(64);
    const failed = new FakeWebRequest();
    failed.throwAfterInstall = true;

    expect(() => installDesktopClientTokenInjector(failed, {
      commandUrl: "http://127.0.0.1:41100/v1/commands",
      rendererStreamUrl: "http://127.0.0.1:41101/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41102",
      clientToken: secret,
      webContentsId: 42,
      getTrustedMainFrame: () => TRUSTED_MAIN_FRAME
    })).toThrow(/registration failed after side effect/u);
    expect(failed.listener).toBeUndefined();
    expect(failed.clearCalls).toBe(1);

    const webRequest = new FakeWebRequest();
    const firstCleanup = installDesktopClientTokenInjector(webRequest, {
      commandUrl: "http://127.0.0.1:41100/v1/commands",
      rendererStreamUrl: "http://127.0.0.1:41101/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41102",
      clientToken: secret,
      webContentsId: 42,
      getTrustedMainFrame: () => TRUSTED_MAIN_FRAME
    });
    firstCleanup();
    expect(webRequest.listener).toBeUndefined();

    const secondCleanup = installDesktopClientTokenInjector(webRequest, {
      commandUrl: "http://127.0.0.1:41100/v1/commands",
      rendererStreamUrl: "http://127.0.0.1:41101/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41102",
      clientToken: secret,
      webContentsId: 43,
      getTrustedMainFrame: () => TRUSTED_MAIN_FRAME
    });
    const secondListener = webRequest.listener;
    firstCleanup();
    expect(webRequest.listener).toBe(secondListener);

    secondCleanup();
    secondCleanup();
    expect(webRequest.listener).toBeUndefined();
  });

  it("does not inject a secret when auth marker headers are ambiguous", () => {
    const webRequest = new FakeWebRequest();
    const secret = "s".repeat(64);
    installDesktopClientTokenInjector(webRequest, {
      commandUrl: "http://127.0.0.1:41100/v1/commands",
      rendererStreamUrl: "http://127.0.0.1:41101/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41102",
      clientToken: secret,
      webContentsId: 42,
      getTrustedMainFrame: () => TRUSTED_MAIN_FRAME
    });

    let output: Record<string, string | string[]> | undefined;
    const ambiguousHeaders = {
      "x-interview-client-token": DESKTOP_AUTH_HEADER_VALUE,
      "X-Interview-Client-Token": DESKTOP_AUTH_HEADER_VALUE
    };
    webRequest.listener?.({
      url: "http://127.0.0.1:41100/v1/commands",
      method: "POST",
      webContentsId: 42,
      frame: TRUSTED_MAIN_FRAME,
      requestHeaders: ambiguousHeaders
    }, (result) => { output = result.requestHeaders; });

    expect(output).toEqual(ambiguousHeaders);
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it("refuses token-injector configuration outside exact loopback endpoints", () => {
    const secret = "s".repeat(64);
    const invalidInputs = [
      {
        commandUrl: "https://attacker.invalid/v1/commands",
        rendererStreamUrl: "http://127.0.0.1:41101/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41102",
        webContentsId: 42
      },
      {
        commandUrl: "http://127.0.0.1:41100/v1/commands?redirect=bad",
        rendererStreamUrl: "http://127.0.0.1:41101/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41102",
        webContentsId: 42
      },
      {
        commandUrl: "http://127.0.0.1:41100/v1/commands",
        rendererStreamUrl: "http://127.0.0.1:41101/not-the-stream",
        voiceBaseUrl: "http://127.0.0.1:41102",
        webContentsId: 42
      },
      {
        commandUrl: "http://127.0.0.1:41100/v1/commands",
        rendererStreamUrl: "http://127.0.0.1:41101/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41102",
        webContentsId: 0
      }
    ];

    for (const input of invalidInputs) {
      const webRequest = new FakeWebRequest();
      expect(() => installDesktopClientTokenInjector(webRequest, {
        ...input,
        clientToken: secret,
        getTrustedMainFrame: () => TRUSTED_MAIN_FRAME
      })).toThrow();
      expect(webRequest.listener).toBeUndefined();
    }

    expect(() => installDesktopClientTokenInjector(new FakeWebRequest(), {
      commandUrl: "http://127.0.0.1:41100/v1/commands",
      rendererStreamUrl: "http://127.0.0.1:41101/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41102",
      clientToken: "x".repeat(31),
      webContentsId: 42,
      getTrustedMainFrame: () => TRUSTED_MAIN_FRAME
    })).toThrow(/token is invalid/u);

    expect(() => installDesktopClientTokenInjector(new FakeWebRequest(), {
      commandUrl: "http://127.0.0.1:41100/v1/commands",
      rendererStreamUrl: "http://127.0.0.1:41101/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41102",
      clientToken: 12345 as never,
      webContentsId: 42,
      getTrustedMainFrame: () => TRUSTED_MAIN_FRAME
    })).toThrow(/token is invalid/u);
  });

  it("keeps the actual preload surface narrow and free of privileged APIs", async () => {
    const preload = await readFile(
      path.resolve(process.cwd(), "apps/desktop/preload.cjs"),
      "utf8"
    );
    expect(preload).toContain('exposeInMainWorld("interviewDesktop"');
    expect(preload).toContain("getBootstrap");
    expect(preload).not.toMatch(/require\(["'](?:node:)?(?:fs|child_process)["']\)/u);
    expect(preload).not.toContain("process.env");
    expect(preload).not.toContain("shell.");
  });

  it("resolves development, production, and app-data paths without exposing them to bootstrap", () => {
    expect(resolveDesktopMode(false, [])).toBe("development");
    expect(resolveDesktopMode(false, ["--desktop-production"])).toBe("production");
    expect(resolveDesktopMode(true, [])).toBe("production");
    expect(resolveDevelopmentFrontendOrigin(undefined)).toBe("http://127.0.0.1:5173");

    const paths = resolveDesktopPaths({
      cwd: "/repo",
      resourcesPath: "/resources",
      userDataPath: path.resolve("test-user-data"),
      isPackaged: false
    });
    expect(paths.frontendRoot).toBe(path.resolve("/repo", "dist/apps/web"));
    expect(paths.appDataRoot).toBe(path.join(path.resolve("test-user-data"), "data"));
    expect(paths.databasePath).toBe(
      path.join(path.resolve("test-user-data"), "data", "interview-session.sqlite")
    );
    expect(() => resolveDesktopPaths({
      cwd: "/repo",
      resourcesPath: "/resources",
      userDataPath: "relative-user-data",
      isPackaged: false
    })).toThrow(/absolute filesystem path/u);
  });

  it("keeps a failed frontend-server close retryable", async () => {
    let closeAttempts = 0;
    const fakeServer = {
      listening: true,
      close(callback: (error?: Error) => void) {
        closeAttempts += 1;
        if (closeAttempts === 1) callback(new Error("frontend close failed"));
        else {
          this.listening = false;
          callback();
        }
      }
    };
    const server = new DesktopFrontendServer("/unused");
    const internals = server as unknown as {
      server: typeof fakeServer | undefined;
      originValue: string | undefined;
    };
    internals.server = fakeServer;
    internals.originValue = "http://127.0.0.1:41234";

    await expect(server.stop()).rejects.toThrow("frontend close failed");
    expect(internals.server).toBe(fakeServer);
    expect(internals.originValue).toBe("http://127.0.0.1:41234");

    await expect(server.stop()).resolves.toBeUndefined();
    expect(internals.server).toBeUndefined();
    expect(internals.originValue).toBeUndefined();
    expect(closeAttempts).toBe(2);
  });

  it("never serves a frontend asset symlink that resolves outside the build root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "interview-desktop-symlink-"));
    roots.push(parent);
    const root = path.join(parent, "web");
    const assets = path.join(root, "assets");
    const secret = path.join(parent, "secret.txt");
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(root, "index.html"), "<!doctype html><div>desktop</div>", "utf8");
    await writeFile(secret, "MUST_NOT_BE_SERVED", "utf8");

    try {
      await symlink(secret, path.join(assets, "leak.txt"), "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
      throw error;
    }

    const server = new DesktopFrontendServer(root);
    const origin = await server.start();
    server.configureBackendOrigins(
      "http://127.0.0.1:42000",
      "http://127.0.0.1:42001/v1/renderer-stream",
      "http://127.0.0.1:42002"
    );

    const response = await fetch(`${origin}/assets/leak.txt`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("MUST_NOT_BE_SERVED");
    await server.stop();
  });

  it("returns a contained 404 if the SPA fallback disappears after startup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "interview-desktop-missing-index-"));
    roots.push(root);
    const indexPath = path.join(root, "index.html");
    await writeFile(indexPath, "<!doctype html><div>desktop</div>", "utf8");

    const server = new DesktopFrontendServer(root);
    const origin = await server.start();
    server.configureBackendOrigins(
      "http://127.0.0.1:42000",
      "http://127.0.0.1:42001/v1/renderer-stream",
      "http://127.0.0.1:42002"
    );
    await rm(indexPath);

    const response = await fetch(`${origin}/client-side-route`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");

    await server.stop();
  });

  it("serves production frontend only after secure backend origins are configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "interview-desktop-web-"));
    roots.push(root);
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "index.html"), "<!doctype html><div>desktop</div>", "utf8");
    await writeFile(path.join(root, "assets/app.js"), "console.log('ok')", "utf8");

    const server = new DesktopFrontendServer(root);
    const origin = await server.start();
    const before = await fetch(origin);
    expect(before.status).toBe(503);

    server.configureBackendOrigins(
      "http://127.0.0.1:42000",
      "http://127.0.0.1:42001/v1/renderer-stream",
      "http://127.0.0.1:42002"
    );
    const response = await fetch(origin);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("desktop");
    expect(response.headers.get("content-security-policy")).toContain("http://127.0.0.1:42000");
    await server.stop();
  });
});
