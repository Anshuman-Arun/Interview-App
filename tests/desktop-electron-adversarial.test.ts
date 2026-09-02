import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newSessionId } from "../packages/domain/src/index.js";
import { TurnCoordinator } from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import { DesktopBackendController } from "../apps/desktop/src/backend-controller.js";
import { createDesktopRendererBootstrap } from "../apps/desktop/src/bootstrap.js";
import { resolveDesktopPaths } from "../apps/desktop/src/paths.js";
import {
  allowDesktopPermissionCheck,
  allowDesktopPermissionRequest,
  installDesktopPermissionCapability
} from "../apps/desktop/src/permission-policy.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("desktop-owned persistence", () => {
  it("uses one stable SQLite location independent of cwd in development and packaged modes", () => {
    const development = resolveDesktopPaths({
      cwd: "/repo-a",
      resourcesPath: "/resources-a",
      userDataPath: path.resolve("test-user-data"),
      isPackaged: false
    });
    const movedCwd = resolveDesktopPaths({
      cwd: "/repo-b",
      resourcesPath: "/resources-b",
      userDataPath: path.resolve("test-user-data"),
      isPackaged: false
    });
    const packaged = resolveDesktopPaths({
      cwd: "/irrelevant",
      resourcesPath: "/opt/app/resources",
      userDataPath: path.resolve("test-user-data"),
      isPackaged: true
    });

    const expected = path.join(path.resolve("test-user-data"), "data", "interview-session.sqlite");
    expect(development.databasePath).toBe(expected);
    expect(movedCwd.databasePath).toBe(expected);
    expect(packaged.databasePath).toBe(expected);
  });

  it("reconstructs the same durable session across two desktop backend lifecycles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "interview-desktop-db-"));
    roots.push(root);
    const paths = resolveDesktopPaths({
      cwd: path.join(root, "cwd-a"),
      resourcesPath: path.join(root, "resources"),
      userDataPath: path.join(root, "user-data"),
      isPackaged: false
    });
    await mkdir(paths.appDataRoot, { recursive: true });
    const sessionId = newSessionId();
    const token = "d".repeat(64);

    const first = new DesktopBackendController();
    const firstServer = await first.start({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: token,
      allowedOrigins: ["http://127.0.0.1:5173"],
      databasePath: paths.databasePath
    });
    const writer = firstServer.registry.get(sessionId);
    const turns = new TurnCoordinator(writer);
    await turns.startSession(sixPeopleProblem);
    await turns.commitInput("Persist this transcript across desktop restart.");
    const before = JSON.parse(JSON.stringify(writer.getState())) as unknown;
    await first.stop();

    const second = new DesktopBackendController();
    const secondServer = await second.start({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      clientToken: token,
      allowedOrigins: ["http://127.0.0.1:5173"],
      databasePath: paths.databasePath
    });
    expect(secondServer.databasePath).toBe(paths.databasePath);
    expect(secondServer.registry.get(sessionId).getState()).toEqual(before);
    await second.stop();
  });

  it("never exposes the SQLite path in renderer bootstrap payload", () => {
    const databasePath = "/private/user-data/data/interview-session.sqlite";
    const bootstrap = createDesktopRendererBootstrap({
      commandBaseUrl: "http://127.0.0.1:41000",
      rendererStreamUrl: "http://127.0.0.1:41001/v1/renderer-stream",
     voiceBaseUrl: "http://127.0.0.1:41002",
      voiceBaseUrl: "http://127.0.0.1:41002",
      appVersion: "test",
      platform: "test"
    });
    expect(JSON.stringify(bootstrap)).not.toContain(databasePath);
    expect(JSON.stringify(bootstrap)).not.toMatch(/databasePath|sqlite|user-data/u);
  });
});

describe("desktop microphone permission policy", () => {
  const trusted = {
    trustedWebContentsId: 17,
    trustedFrontendOrigin: "http://127.0.0.1:5173"
  };
  const webContents = { id: 17 };

  it("permits only an exact trusted main-frame audio-only media request", () => {
    expect(allowDesktopPermissionRequest(webContents, "media", {
      requestingUrl: "http://127.0.0.1:5173/interview",
      isMainFrame: true,
      mediaTypes: ["audio"]
    }, trusted)).toBe(true);

    for (const mediaTypes of [["video"], ["audio", "video"], [], undefined]) {
      expect(allowDesktopPermissionRequest(webContents, "media", {
        requestingUrl: "http://127.0.0.1:5173/interview",
        isMainFrame: true,
        ...(mediaTypes === undefined ? {} : { mediaTypes })
      }, trusted)).toBe(false);
    }
  });

  it("denies unexpected WebContents, subframes, navigated origins, and every non-media permission", () => {
    expect(allowDesktopPermissionRequest({ id: 99 }, "media", {
      requestingUrl: "http://127.0.0.1:5173/",
      isMainFrame: true,
      mediaTypes: ["audio"]
    }, trusted)).toBe(false);
    expect(allowDesktopPermissionRequest(webContents, "media", {
      requestingUrl: "http://127.0.0.1:5173/",
      isMainFrame: false,
      mediaTypes: ["audio"]
    }, trusted)).toBe(false);
    expect(allowDesktopPermissionRequest(webContents, "media", {
      requestingUrl: "https://attacker.invalid/",
      isMainFrame: true,
      mediaTypes: ["audio"]
    }, trusted)).toBe(false);

    for (const permission of [
      "display-capture",
      "notifications",
      "geolocation",
      "midi",
      "midiSysex",
      "serial",
      "usb",
      "hid",
      "clipboard-read",
      "clipboard-sanitized-write",
      "unknown"
    ]) {
      expect(allowDesktopPermissionRequest(webContents, permission, {
        requestingUrl: "http://127.0.0.1:5173/",
        isMainFrame: true,
        mediaTypes: ["audio"]
      }, trusted)).toBe(false);
    }
  });

  it("fails closed when the configured permission trust root is invalid", () => {
    const request = {
      requestingUrl: "https://attacker.invalid/interview",
      isMainFrame: true,
      mediaTypes: ["audio"] as const
    };
    expect(allowDesktopPermissionRequest(
      { id: 17 },
      "media",
      request,
      {
        trustedWebContentsId: 17,
        trustedFrontendOrigin: "https://attacker.invalid"
      }
    )).toBe(false);
    expect(allowDesktopPermissionRequest(
      { id: 0 },
      "media",
      {
        requestingUrl: "http://127.0.0.1:5173/",
        isMainFrame: true,
        mediaTypes: ["audio"]
      },
      {
        trustedWebContentsId: 0,
        trustedFrontendOrigin: "http://127.0.0.1:5173"
      }
    )).toBe(false);

    const session = {
      requestHandlerSet: false,
      checkHandlerSet: false,
      setPermissionRequestHandler(handler: unknown) {
        this.requestHandlerSet ||= handler !== null;
      },
      setPermissionCheckHandler(handler: unknown) {
        this.checkHandlerSet ||= handler !== null;
      }
    };
    expect(() => installDesktopPermissionCapability(session, {
      trustedWebContentsId: 17,
      trustedFrontendOrigin: "https://attacker.invalid"
    })).toThrow(/loopback/u);
    expect(session.requestHandlerSet).toBe(false);
    expect(session.checkHandlerSet).toBe(false);
  });

  it("applies the same fail-closed constraints at permission-check time", () => {
    expect(allowDesktopPermissionCheck(
      webContents,
      "media",
      "http://127.0.0.1:5173",
      {
        requestingUrl: "http://127.0.0.1:5173/interview",
        securityOrigin: "http://127.0.0.1:5173",
        isMainFrame: true,
        mediaType: "audio"
      },
      trusted
    )).toBe(true);

    expect(allowDesktopPermissionCheck(
      webContents,
      "media",
      "http://127.0.0.1:5173",
      { isMainFrame: true, mediaType: "video" },
      trusted
    )).toBe(false);
    expect(allowDesktopPermissionCheck(
      null,
      "media",
      "http://127.0.0.1:5173",
      { isMainFrame: false, mediaType: "audio" },
      trusted
    )).toBe(false);
    expect(allowDesktopPermissionCheck(
      webContents,
      "media",
      "https://attacker.invalid",
      { isMainFrame: true, mediaType: "audio" },
      trusted
    )).toBe(false);
  });
});
