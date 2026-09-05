import { describe, expect, it } from "vitest";
import {
  isHeadlessCliLaunch,
  STARTUP_WINDOW_DATA_URL,
  STARTUP_WINDOW_HTML,
  getStartupWindowOptions
} from "../apps/desktop/src/startup-window.js";
import {
  DESKTOP_SESSION_PARTITION,
  createSecureStartupWebPreferences
} from "../apps/desktop/src/window-config.js";

describe("desktop startup window configuration and lifecycle", () => {
  it("classifies headless CLI runs and GUI launches correctly", () => {
    expect(isHeadlessCliLaunch(["node", "main.js", "--install-local-models"])).toBe(true);
    expect(isHeadlessCliLaunch(["node", "main.js", "--install-local-vision-models"])).toBe(true);
    expect(isHeadlessCliLaunch(["node", "main.js", "--packaged-single-instance-smoke-probe"])).toBe(true);

    // GUI launches must show the startup window
    expect(isHeadlessCliLaunch(["Interview App.exe"])).toBe(false);
    expect(isHeadlessCliLaunch(["Interview App.exe", "--desktop-production"])).toBe(false);
    expect(isHeadlessCliLaunch(["Interview App.exe", "--local-model-activation"])).toBe(false);
    expect(isHeadlessCliLaunch(["Interview App.exe", "--packaged-smoke-test"])).toBe(false);
  });

  it("provides frameless, non-resizable startup window options", () => {
    const opts = getStartupWindowOptions();
    expect(opts.frame).toBe(false);
    expect(opts.resizable).toBe(false);
    expect(opts.show).toBe(false);
  });

  it("provides secure startup web preferences with no preload exposure and strict sandboxing", () => {
    const prefs = createSecureStartupWebPreferences();
    expect(prefs).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      partition: DESKTOP_SESSION_PARTITION
    });
    // Must NOT have a preload script attached
    expect((prefs as { preload?: unknown }).preload).toBeUndefined();
  });

  it("serves a self-contained HTML splash page with strict Content-Security-Policy", () => {
    expect(STARTUP_WINDOW_HTML).toContain("default-src 'none'");
    expect(STARTUP_WINDOW_HTML).toContain("window.updateStatus");
    expect(STARTUP_WINDOW_HTML).toContain("Interview App");
    expect(STARTUP_WINDOW_HTML).toContain("status-text");
    expect(STARTUP_WINDOW_HTML).toContain("progress-bar");

    expect(STARTUP_WINDOW_DATA_URL.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    const decoded = decodeURIComponent(
      STARTUP_WINDOW_DATA_URL.slice("data:text/html;charset=utf-8,".length)
    );
    expect(decoded).toBe(STARTUP_WINDOW_HTML);
  });
});
