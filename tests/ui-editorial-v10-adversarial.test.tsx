// @vitest-environment happy-dom
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIdSchema } from "../packages/domain/src/index.js";
import { AppearanceProvider } from "../apps/web/src/appearance/AppearanceProvider.js";
import { ProductFrame } from "../apps/web/src/components/ProductFrame.js";
import {
  TranscriptFeed,
  type TranscriptItem
} from "../apps/web/src/components/TranscriptFeed.js";
import { HomePage } from "../apps/web/src/pages/HomePage.js";
import { NewInterviewPage } from "../apps/web/src/pages/NewInterviewPage.js";
import { SettingsPage } from "../apps/web/src/pages/SettingsPage.js";
import { SessionsPage } from "../apps/web/src/pages/SessionsPage.js";
import { ReviewReadPanel } from "../apps/web/src/pages/ReviewReadPanel.js";

const ACT_ENVIRONMENT_KEY = "IS_REACT_ACT_ENVIRONMENT";
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function transcriptItem(id: string, text: string): TranscriptItem {
  return {
    id,
    role: "interviewer",
    text,
    status: "COMPLETED",
    timestamp: Date.parse("2026-09-04T20:00:00.000Z")
  };
}

describe("editorial v10 adversarial UI states", () => {
  beforeEach(() => {
    Reflect.set(globalThis, ACT_ENVIRONMENT_KEY, true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value(this: HTMLElement, options?: ScrollToOptions | number): void {
        if (typeof options === "number") {
          this.scrollTop = options;
          return;
        }
        if (options?.top !== undefined) this.scrollTop = options.top;
      }
    });
  });

  afterEach(async () => {
    if (root !== undefined) {
      await act(async () => root?.unmount());
    }
    root = undefined;
    host?.remove();
    host = undefined;
    vi.restoreAllMocks();
  });

  it("serializes same-item transcript retries before a second network commit", () => {
    const hook = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/hooks/useInterviewSession.ts"),
      "utf8"
    );

    expect(hook).toContain(
      "const retrySubmissionsInFlightRef = useRef<Set<string>>(new Set())"
    );
    expect(hook).toContain(
      "if (retrySubmissionsInFlightRef.current.has(itemId)) return"
    );
    expect(hook).toContain("retrySubmissionsInFlightRef.current.add(itemId)");
    expect(hook).toContain("retrySubmissionsInFlightRef.current.delete(itemId)");
  });

  it("contains rejecting transcript retry callbacks at the component boundary", async () => {
    const onRetry = vi.fn(async () => {
      throw new Error("retry transport failed");
    });

    await act(async () => {
      root?.render(
        <TranscriptFeed
          items={[{
            ...transcriptItem("retry-1", "Retry this turn"),
            errorMessage: "transport failed"
          }]}
          onRetry={onRetry}
        />
      );
    });

    const retry = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent.trim() === "Retry");
    if (!(retry instanceof HTMLButtonElement)) {
      throw new Error("Transcript retry action did not mount");
    }

    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("resets transcript follow state when session identity changes", async () => {
    await act(async () => {
      root?.render(
        <TranscriptFeed
          items={[transcriptItem("a-1", "First session")]}
          scrollContextKey="session-a"
        />
      );
    });

    const messages = document.querySelector(".transcript-feed__messages");
    if (!(messages instanceof HTMLDivElement)) {
      throw new Error("Transcript scroller did not mount");
    }

    let scrollTop = 800;
    Object.defineProperties(messages, {
      scrollHeight: { configurable: true, get: () => 1000 },
      clientHeight: { configurable: true, get: () => 200 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        }
      }
    });

    scrollTop = 100;
    await act(async () => {
      messages.dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector(".transcript-feed__jump")).not.toBeNull();

    await act(async () => {
      root?.render(
        <TranscriptFeed items={[]} scrollContextKey="session-b" />
      );
    });
    expect(document.querySelector(".transcript-feed__jump")).toBeNull();
    expect(scrollTop).toBe(0);

    await act(async () => {
      root?.render(
        <TranscriptFeed
          items={[transcriptItem("b-1", "Second session")]}
          scrollContextKey="session-b"
        />
      );
    });
    expect(scrollTop).toBe(1000);
    expect(document.querySelector(".transcript-feed__jump")).toBeNull();
  });

  it("counts an attached active room separately when storage only lists another active room", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain("const attachedActiveMissingFromStored =");
    expect(app).toContain(
      "storedActiveSessions.length + (attachedActiveMissingFromStored ? 1 : 0)"
    );
  });

  it("keeps Sessions recovery reachable when authority is unavailable with multiple cached active rooms", () => {
    const home = renderToStaticMarkup(
      <HomePage
        activeSessionId={null}
        activeSessionCount={2}
        sessions={[]}
        onStartInterview={vi.fn()}
        onResumeInterview={vi.fn()}
        onOpenSessions={vi.fn()}
        onOpenSettings={vi.fn()}
        canReview={() => false}
        onReview={vi.fn()}
        sessionEntryPending={false}
        sessionAuthorityUnavailable
      />
    );

    expect(home).toContain("Choose active session");
    expect(home).toMatch(/<button[^>]*>\s*<span>Choose active session<\/span>/u);
    expect(home).not.toMatch(/<button[^>]*disabled=""[^>]*>\s*<span>Choose active session<\/span>/u);
    expect(home).toMatch(/<button[^>]*>Open Sessions<\/button>/u);
  });

  it("does not offer a false new-session action when multiple active sessions exist", () => {
    const home = renderToStaticMarkup(
      <HomePage
        activeSessionId={null}
        activeSessionCount={2}
        sessions={[]}
        onStartInterview={vi.fn()}
        onResumeInterview={vi.fn()}
        onOpenSessions={vi.fn()}
        onOpenSettings={vi.fn()}
        canReview={() => false}
        onReview={vi.fn()}
        sessionEntryPending={false}
      />
    );
    expect(home).toContain("Choose active session");
    expect(home).not.toContain('data-testid="start-session-btn"');

    const configure = renderToStaticMarkup(
      <NewInterviewPage
        catalog={[]}
        catalogLoading={false}
        catalogError={null}
        providerOptions={[]}
        providerOptionsLoading={false}
        providerOptionsError={null}
        activeSessionId={null}
        activeSessionCount={2}
        startPending={false}
        onRefreshCatalog={async () => []}
        onRefreshProviderOptions={async () => []}
        onStart={async () => undefined}
        onResumeActive={null}
      />
    );
    expect(configure).toContain("ACTIVE SESSION CONFLICT");
    expect(configure).toMatch(
      /<button(?=[^>]*data-testid="start-configured-session-btn")(?=[^>]*disabled)[^>]*>/
    );
  });

  it("blocks new-session entry while cold-route stored authority is being checked", async () => {
    const home = renderToStaticMarkup(
      <HomePage
        activeSessionId={null}
        activeSessionCount={0}
        sessions={[]}
        onStartInterview={vi.fn()}
        onResumeInterview={vi.fn()}
        onOpenSessions={vi.fn()}
        onOpenSettings={vi.fn()}
        canReview={() => false}
        onReview={vi.fn()}
        sessionEntryPending={false}
        sessionAuthorityChecking
      />
    );
    expect(home).toContain("Checking rooms…");
    expect(home).toMatch(/<button(?=[^>]*data-testid="start-session-btn")(?=[^>]*disabled="")[^>]*>/u);

    const onStart = vi.fn(async () => undefined);
    await act(async () => {
      root?.render(
        <NewInterviewPage
          catalog={[{
            mode: "OXFORD_MATHEMATICS",
            id: "cold-route",
            version: "1",
            title: "Cold route",
            category: "proof",
            difficulty: "standard"
          }]}
          catalogLoading={false}
          catalogError={null}
          providerOptions={[{
            providerId: "test-provider",
            providerDisplayName: "Test Provider",
            providerKind: "MOCK",
            modelId: "test-model",
            modelDisplayName: "Test Model",
            availability: "AVAILABLE"
          }]}
          providerOptionsLoading={false}
          providerOptionsError={null}
          activeSessionId={null}
          activeSessionCount={0}
          startPending={false}
          sessionAuthorityChecking
          onRefreshCatalog={async () => []}
          onRefreshProviderOptions={async () => []}
          onStart={onStart}
          onResumeActive={null}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const form = document.querySelector(".new-interview__layout");
    const start = document.querySelector("[data-testid='start-configured-session-btn']");
    if (!(form instanceof HTMLFormElement) || !(start instanceof HTMLButtonElement)) {
      throw new Error("Cold-route launch controls did not mount");
    }
    expect(start.disabled).toBe(true);
    expect(host?.textContent).toContain("Checking stored session authority…");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(onStart).not.toHaveBeenCalled();

    const settings = renderToStaticMarkup(
      <AppearanceProvider>
        <SettingsPage
          providerOptions={[{
            providerId: "ready-provider",
            providerDisplayName: "Ready Provider",
            providerKind: "REMOTE_API",
            modelId: "ready-model",
            modelDisplayName: "Ready Model",
            availability: "AVAILABLE"
          }]}
          providerOptionsLoading={false}
          providerOptionsError={null}
          activeSessionCount={0}
          sessionAuthorityChecking
          onRefreshProviderOptions={async () => []}
          onStartInterview={vi.fn()}
        />
      </AppearanceProvider>
    );
    expect(settings).toContain(
      "Checking stored session authority before enabling a new interview."
    );
    expect(settings).toMatch(
      /<button[^>]*disabled=""[^>]*>Start interview<\/button>/u
    );

    const appSource = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    expect(appSource).toContain(
      "const [sessionAuthorityChecking, setSessionAuthorityChecking] = useState(true)"
    );
    expect(appSource).toContain("sessionAuthorityCheckEpochRef.current === checkEpoch");
  });

  it("fails closed when one stored active session has not resolved to an attached id", async () => {
    const onStart = vi.fn(async () => undefined);

    await act(async () => {
      root?.render(
        <NewInterviewPage
          catalog={[{
            mode: "OXFORD_MATHEMATICS",
            id: "unresolved-active",
            version: "1",
            title: "Unresolved active authority",
            category: "proof",
            difficulty: "standard"
          }]}
          catalogLoading={false}
          catalogError={null}
          providerOptions={[{
            providerId: "test-provider",
            providerDisplayName: "Test Provider",
            providerKind: "MOCK",
            modelId: "test-model",
            modelDisplayName: "Test Model",
            availability: "AVAILABLE"
          }]}
          providerOptionsLoading={false}
          providerOptionsError={null}
          activeSessionId={null}
          activeSessionCount={1}
          startPending={false}
          onRefreshCatalog={async () => []}
          onRefreshProviderOptions={async () => []}
          onStart={onStart}
          onResumeActive={null}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host?.textContent).toContain("An active session is stored but not attached.");
    const form = document.querySelector(".new-interview__layout");
    const start = document.querySelector("[data-testid='start-configured-session-btn']");
    if (!(form instanceof HTMLFormElement) || !(start instanceof HTMLButtonElement)) {
      throw new Error("Unresolved active-session launch controls did not mount");
    }
    expect(start.disabled).toBe(true);

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(onStart).not.toHaveBeenCalled();
    expect(host?.textContent).toContain(
      "An active interview exists but is not attached yet."
    );
  });

  it("fails closed before submit when duration is outside the launch contract", async () => {
    await act(async () => {
      root?.render(
        <NewInterviewPage
          catalog={[{
            mode: "OXFORD_MATHEMATICS",
            id: "duration-edge",
            version: "1",
            title: "Duration edge case",
            category: "proof",
            difficulty: "standard"
          }]}
          catalogLoading={false}
          catalogError={null}
          providerOptions={[{
            providerId: "test-provider",
            providerDisplayName: "Test Provider",
            providerKind: "MOCK",
            modelId: "test-model",
            modelDisplayName: "Test Model",
            availability: "AVAILABLE"
          }]}
          providerOptionsLoading={false}
          providerOptionsError={null}
          activeSessionId={null}
          activeSessionCount={0}
          startPending={false}
          onRefreshCatalog={async () => []}
          onRefreshProviderOptions={async () => []}
          onStart={vi.fn(async () => undefined)}
          onResumeActive={null}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const duration = document.querySelector("[data-testid='duration-input']");
    const start = document.querySelector("[data-testid='start-configured-session-btn']");
    if (!(duration instanceof HTMLInputElement) || !(start instanceof HTMLButtonElement)) {
      throw new Error("New Interview duration controls did not mount");
    }
    const valueDescriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    );
    if (valueDescriptor?.set === undefined) {
      throw new Error("input value setter unavailable");
    }
    const setValue = (value: string): void => {
      valueDescriptor.set?.call(duration, value);
    };

    expect(start.disabled).toBe(false);

    await act(async () => {
      setValue("4");
      duration.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(duration.getAttribute("aria-invalid")).toBe("true");
    expect(start.disabled).toBe(true);
    expect(host?.textContent).toContain(
      "Duration must be a whole number from 5 to 480 minutes."
    );

    await act(async () => {
      setValue("5");
      duration.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(duration.getAttribute("aria-invalid")).toBe("false");
    expect(start.disabled).toBe(false);

    await act(async () => {
      setValue("5.5");
      duration.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(start.disabled).toBe(true);
  });

  it("does not allow form submission while launch metadata is revalidating", async () => {
    const onStart = vi.fn(async () => undefined);

    await act(async () => {
      root?.render(
        <NewInterviewPage
          catalog={[{
            mode: "OXFORD_MATHEMATICS",
            id: "stale-launch",
            version: "1",
            title: "Stale launch metadata",
            category: "proof",
            difficulty: "standard"
          }]}
          catalogLoading={false}
          catalogError={null}
          providerOptions={[{
            providerId: "test-provider",
            providerDisplayName: "Test Provider",
            providerKind: "MOCK",
            modelId: "test-model",
            modelDisplayName: "Test Model",
            availability: "AVAILABLE"
          }]}
          providerOptionsLoading
          providerOptionsError={null}
          activeSessionId={null}
          activeSessionCount={0}
          startPending={false}
          onRefreshCatalog={async () => []}
          onRefreshProviderOptions={() => new Promise(() => undefined)}
          onStart={onStart}
          onResumeActive={null}
        />
      );
      await Promise.resolve();
    });

    const form = document.querySelector(".new-interview__layout");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("New Interview form did not mount");
    }

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(onStart).not.toHaveBeenCalled();
    expect(host?.textContent).toContain(
      "Launch readiness is still being verified."
    );
  });

  it("does not block setup when a non-Antigravity provider is launch-ready", () => {
    const markup = renderToStaticMarkup(
      <AppearanceProvider>
        <SettingsPage
          providerOptions={[
            {
              providerId: "antigravity-cli",
              providerDisplayName: "Antigravity CLI",
              providerKind: "LOCAL_PROCESS",
              modelId: "gemini-local",
              modelDisplayName: "Gemini Local",
              availability: "UNAVAILABLE",
              reason: "CREDENTIALS_REQUIRED"
            },
            {
              providerId: "gemini-api",
              providerDisplayName: "Gemini API",
              providerKind: "REMOTE_API",
              modelId: "gemini-remote",
              modelDisplayName: "Gemini Remote",
              availability: "AVAILABLE"
            }
          ]}
          providerOptionsLoading={false}
          providerOptionsError={null}
          onRefreshProviderOptions={async () => []}
          onStartInterview={vi.fn()}
        />
      </AppearanceProvider>
    );

    expect(markup).toContain("Gemini API");
    expect(markup).toContain("Gemini Remote");
    expect(markup).toContain("Typed interviews are ready.");
    expect(markup).not.toMatch(
      /<button[^>]*disabled=""[^>]*>Start interview<\/button>/u
    );
  });

  it("does not offer Settings start while stored active authority exists", () => {
    const markup = renderToStaticMarkup(
      <AppearanceProvider>
        <SettingsPage
          providerOptions={[{
            providerId: "ready-provider",
            providerDisplayName: "Ready Provider",
            providerKind: "REMOTE_API",
            modelId: "ready-model",
            modelDisplayName: "Ready Model",
            availability: "AVAILABLE"
          }]}
          providerOptionsLoading={false}
          providerOptionsError={null}
          activeSessionCount={1}
          onRefreshProviderOptions={async () => []}
          onStartInterview={vi.fn()}
        />
      </AppearanceProvider>
    );

    expect(markup).toContain(
      "An active interview already exists. Resume or resolve it before starting another."
    );
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*>Start interview<\/button>/u
    );
  });

  it("claims the setup operation lock before restarting the desktop app", () => {
    const settings = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/pages/SettingsPage.tsx"),
      "utf8"
    );
    const restartStart = settings.indexOf("const restartApp = desktopRuntime?.restartApp");
    const restartEnd = settings.indexOf("disabled={restarting || anyInstallActive}", restartStart);
    const restartBlock = settings.slice(restartStart, restartEnd);

    expect(restartStart).toBeGreaterThan(-1);
    expect(restartBlock).toContain("setupOperationInFlightRef.current = true");
    expect(restartBlock).toContain("setRestarting(true)");
    expect(restartBlock).toContain("setupOperationInFlightRef.current = false");
  });

  it("does not advertise shell readiness when session authority is unavailable", () => {
    const markup = renderToStaticMarkup(
      <AppearanceProvider>
        <ProductFrame
          activePage="home"
          title="Home"
          kicker="Interview room"
          onNavigate={vi.fn()}
          reasoningReady
          authorityUnavailable
        >
          content
        </ProductFrame>
      </AppearanceProvider>
    );

    expect(markup).toContain("Session check needed");
    expect(markup).toContain(">RETRY<");
    expect(markup).toContain("CHECK SESSIONS");
    expect(markup).toContain('data-ready="false"');
  });

  it("keeps shell checking and ready states mutually exclusive", () => {
    const markup = renderToStaticMarkup(
      <AppearanceProvider>
        <ProductFrame
          activePage="home"
          title="Home"
          kicker="Interview room"
          onNavigate={vi.fn()}
          reasoningReady
          reasoningChecking
        >
          content
        </ProductFrame>
      </AppearanceProvider>
    );

    expect(markup).toContain("CHECKING");
    expect(markup).not.toContain('data-ready="true"');
  });

  it("shows provider rechecks as checking rather than ready", () => {
    const markup = renderToStaticMarkup(
      <AppearanceProvider>
        <ProductFrame
          activePage="home"
          title="Home"
          kicker="Interview room"
          onNavigate={vi.fn()}
          reasoningReady={false}
          reasoningChecking
        >
          content
        </ProductFrame>
      </AppearanceProvider>
    );

    expect(markup).toContain("Checking");
    expect(markup).toContain("CHECKING");
    expect(markup).not.toContain(">READY<");
  });

  it("cancels stale default-review auto-upgrades after route intent changes", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain("const reviewAutoUpgradePendingRef = useRef");
    expect(app).toMatch(
      /const atIntendedReplay =[\s\S]{0,220}route\.page === "review"[\s\S]{0,180}route\.view === "replay";[\s\S]{0,220}if \(!atIntendedReplay\) \{[\s\S]{0,160}reviewAutoUpgradeEpochRef\.current \+= 1;[\s\S]{0,120}reviewAutoUpgradePendingRef\.current = null;/u
    );
    expect(app).toMatch(
      /pending\.resolvedOxford = true;[\s\S]{0,260}currentRoute\.page !== "review"[\s\S]{0,180}return;[\s\S]{0,180}reviewAutoUpgradePendingRef\.current = null;[\s\S]{0,180}view: "evaluation"/u
    );
    expect(app).toMatch(
      /reviewAutoUpgradeEpochRef\.current \+= 1;\s*reviewAutoUpgradePendingRef\.current = null;\s*navigate\(/u
    );
    expect(app).toMatch(
      /useEffect\(\(\) => \{\s*reviewAutoUpgradeEpochRef\.current \+= 1;\s*reviewAutoUpgradePendingRef\.current = null;[\s\S]{0,260}\}, \[session\.baseUrl\]\);/u
    );
    expect(app).toContain('key={`${session.baseUrl}:${sessionId}`}');
  });

  it("retries a transient bounded review read in place", async () => {
    const sessionId = SessionIdSchema.parse(
      "session_00000000-0000-4000-8000-000000000401"
    );
    const readEvaluation = vi.fn()
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockImplementationOnce(() => new Promise(() => undefined));

    await act(async () => {
      root?.render(
        <ReviewReadPanel
          sessionId={sessionId}
          view="evaluation"
          readEvaluation={readEvaluation}
          readReplay={vi.fn(() => new Promise<never>(() => undefined))}
          readPerformance={vi.fn(() => new Promise<never>(() => undefined))}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host?.textContent).toContain(
      "The evaluation could not be loaded."
    );
    const retry = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent.trim() === "Retry read");
    if (!(retry instanceof HTMLButtonElement)) {
      throw new Error("Review retry action did not mount");
    }

    await act(async () => {
      retry.click();
      await Promise.resolve();
    });

    expect(readEvaluation).toHaveBeenCalledTimes(2);
    expect(host?.textContent).toContain("Loading evaluation…");
  });

  it("does not let a failed Replay read mask a cached Evaluation", async () => {
    const sessionId = SessionIdSchema.parse(
      "session_00000000-0000-4000-8000-000000000402"
    );
    const readEvaluation = vi.fn(async () => ({
      protocolVersion: 1 as const,
      type: "SESSION_EVALUATION_READ" as const,
      sessionId,
      available: false as const,
      reason: "EVALUATION_UNAVAILABLE" as const
    }));
    const readReplay = vi.fn(async () => {
      throw new Error("temporary replay failure");
    });
    const readPerformance = vi.fn(() => new Promise<never>(() => undefined));

    await act(async () => {
      root?.render(
        <ReviewReadPanel
          sessionId={sessionId}
          view="evaluation"
          readEvaluation={readEvaluation}
          readReplay={readReplay}
          readPerformance={readPerformance}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host?.textContent).toContain("NOT SCORED");

    await act(async () => {
      root?.render(
        <ReviewReadPanel
          sessionId={sessionId}
          view="replay"
          readEvaluation={readEvaluation}
          readReplay={readReplay}
          readPerformance={readPerformance}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host?.textContent).toContain(
      "The replay could not be loaded."
    );

    await act(async () => {
      root?.render(
        <ReviewReadPanel
          sessionId={sessionId}
          view="evaluation"
          readEvaluation={readEvaluation}
          readReplay={readReplay}
          readPerformance={readPerformance}
        />
      );
      await Promise.resolve();
    });

    expect(host?.textContent).toContain("NOT SCORED");
    expect(host?.textContent).not.toContain("replay could not be loaded");
    expect(readEvaluation).toHaveBeenCalledTimes(1);
  });

  it("keeps the supported 5x zoom usable at the desktop minimum window", () => {
    const windowConfig = fs.readFileSync(
      path.resolve(process.cwd(), "apps/desktop/src/window-config.ts"),
      "utf8"
    );
    const desktopBootstrap = fs.readFileSync(
      path.resolve(process.cwd(), "apps/desktop/src/bootstrap.ts"),
      "utf8"
    );
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const editorialCss = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/editorial-v10.css"),
      "utf8"
    );
    const appearanceCss = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/AppearanceDock.css"),
      "utf8"
    );

    expect(windowConfig).toContain("DESKTOP_MIN_WIDTH = 960");
    expect(windowConfig).toContain("DESKTOP_MIN_HEIGHT = 640");
    expect(desktopBootstrap).toContain("DESKTOP_MAX_ZOOM_FACTOR = 5");
    expect(app).toContain('className="app-header__end-long"');
    expect(editorialCss).toContain("@media (max-width: 240px)");
    expect(editorialCss).toContain("@media (max-height: 200px)");
    expect(editorialCss).toMatch(
      /@media \(max-height: 360px\)[\s\S]*?\.app-header\s*\{[\s\S]*?min-height:\s*42px !important;[\s\S]*?flex:\s*0 0 42px;/u
    );
    expect(editorialCss).toMatch(
      /@media \(max-height: 200px\)[\s\S]*?\.app-header\s*\{[\s\S]*?min-height:\s*30px !important;[\s\S]*?flex:\s*0 0 30px;/u
    );
    expect(editorialCss).toMatch(
      /@media \(max-width: 240px\)[\s\S]*?\.app-header__end-long\s*\{\s*display:\s*none;[\s\S]*?\.expressive-settings__zoom-stepper\s*\{[\s\S]*?grid-template-columns:\s*28px minmax\(0, 1fr\) 28px;/u
    );
    expect(editorialCss).toMatch(
      /@media \(max-height: 200px\)[\s\S]*?\.problem-block\s*\{\s*max-height:\s*18px;[\s\S]*?\.input-dock \.voice-strip\s*\{[\s\S]*?min-height:\s*14px;[\s\S]*?\.input-dock \.reasoning-composer__textarea\s*\{[\s\S]*?min-height:\s*22px;/u
    );
    expect(appearanceCss).toMatch(
      /@media \(max-width: 240px\)[\s\S]*?\.appearance-swatches\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/u
    );
  });

  it("keeps compact and sync-state contracts explicit in source and CSS", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const frameCss = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/ProductFrame.css"),
      "utf8"
    );
    const editorialCss = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/editorial-v10.css"),
      "utf8"
    );
    const transcriptCss = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/TranscriptFeed.css"),
      "utf8"
    );
    const appCss = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/app.css"),
      "utf8"
    );

    expect(app).toContain("scrollContextKey={session.sessionId}");
    expect(app).toContain('className="board-appbar__layout-action"');
    expect(app).toContain('className="board-appbar__clear-action"');
    expect(app).toContain('aria-haspopup="dialog"');
    expect(app).toContain('event.pointerType === "mouse" && event.button !== 0');
    expect(app).toContain("retrySubmission(itemId).catch(() => undefined)");
    expect(app).toContain("const beginSessionAuthorityCheck = useCallback");
    expect(app).toMatch(
      /route\.page === "sessions"[\s\S]{0,120}return refreshStoredSessions\(\);[\s\S]{0,120}return beginSessionAuthorityCheck\(\);/u
    );
    expect(app).toMatch(
      /route\.page !== "home"[\s\S]{0,140}route\.page !== "sessions"[\s\S]{0,140}route\.page !== "review"[\s\S]{0,220}refreshProviderOptions\(\)\.catch/u
    );
    expect(app).toMatch(
      /storedSession\.status === "ACTIVE"[\s\S]{0,180}storedSession\.sessionId === session\.sessionId[\s\S]{0,180}session\.sessionStatus === "COMPLETED"[\s\S]{0,100}session\.sessionStatus === "ARCHIVED"/u
    );
    expect(app).toMatch(
      /setCompactPane\("interview"\);[\s\S]{0,100}setPaneFocus\("split"\);[\s\S]{0,100}setSplitPercent\(38\);[\s\S]{0,100}\}, \[session\.sessionId\]\);/u
    );
    expect(app).toMatch(
      /app-header__board-state"[\s\S]{0,100}data-sync=\{session\.whiteboardSync\.status\}/u
    );

    expect(frameCss).not.toContain(".product-frame__nav::before");
    expect(editorialCss).toContain(".board-appbar__layout-action");
    expect(editorialCss).toMatch(
      /\.expressive-home__hero\s*\{[^}]*overflow:\s*visible;/u
    );
    expect(editorialCss).not.toContain(
      ".live-pane-heading button,\n  .board-appbar__actions button {\n    display: none;"
    );
    expect(editorialCss).toMatch(
      /@media \(max-width: 960px\)[\s\S]*?\.live-main\[data-focus\] \.reasoning-pane,[\s\S]*?\.live-main\[data-focus\] \.board-pane \{[\s\S]*?display:\s*flex;/u
    );
    expect(editorialCss).not.toMatch(
      /@media \(max-width: 900px\)[\s\S]{0,300}\.quant-side\s*\{\s*display:\s*none/u
    );
    expect(editorialCss).toContain(
      ".new-interview__select-wrap select:focus-visible"
    );
    expect(editorialCss).toMatch(
      /\.new-interview__duration input:focus-visible[\s\S]{0,160}outline:\s*2px solid var\(--accent\)/u
    );
    expect(editorialCss).toMatch(
      /\.problem-block\s*\{[^}]*max-height:\s*min\(34vh, 300px\);[^}]*overflow-y:\s*auto;/u
    );
    expect(editorialCss).toContain(
      ".input-dock .voice-strip__popover"
    );
    expect(editorialCss).toContain("@media (max-height: 360px)");
    expect(editorialCss).toMatch(
      /@media \(max-height: 360px\)[\s\S]*?\.problem-block\s*\{[\s\S]*?max-height:\s*36px;[\s\S]*?overflow-y:\s*auto;[\s\S]*?padding:\s*0;[\s\S]*?\.input-dock \.reasoning-composer__textarea\s*\{[\s\S]*?min-height:\s*28px;/u
    );
    expect(editorialCss).not.toMatch(
      /@media \(max-height: 360px\)[\s\S]{0,240}\.problem-block\s*\{[^}]*display:\s*none;/u
    );
    expect(editorialCss).toContain(
      "width: min(340px, 24vw);"
    );
    expect(transcriptCss).toContain(
      "@media(max-width:960px){.transcript-feed__focus{display:none}}"
    );
    expect(transcriptCss).not.toContain(
      ".transcript-feed__jump,.transcript-feed__focus{display:none}"
    );
    expect(appCss).toContain(
      ".app-header__board-state[data-sync=UNSYNCHRONIZED]>span{background:var(--danger)}"
    );
    expect(editorialCss).toMatch(
      /\.expressive-home__folio\s*\{[^}]*transform:\s*translateX\(-16px\);/u
    );
    expect(frameCss).toContain("scrollbar-width: none;");
    expect(frameCss).toMatch(
      /\.product-frame__content::\-webkit-scrollbar,[\s\S]{0,120}display:\s*none;/u
    );
    expect(editorialCss).toMatch(
      /\.live-main\[data-focus="transcript"\],[\s\S]{0,100}\.live-main\[data-focus="whiteboard"\]\s*\{[\s\S]{0,120}grid-template-columns:\s*minmax\(0,\s*1fr\)\s*!important;/u
    );
  });


  it("does not expose dead Sessions or review navigation while an attached interview is paused", () => {
    const activeSession = SessionIdSchema.parse(
      "session_00000000-0000-4000-8000-000000000301"
    );
    const completedSession = SessionIdSchema.parse(
      "session_00000000-0000-4000-8000-000000000302"
    );

    const frame = renderToStaticMarkup(
      <AppearanceProvider>
        <ProductFrame
          activePage="home"
          title="Home"
          kicker="Interview room"
          onNavigate={vi.fn()}
          navigationLocked
        >
          content
        </ProductFrame>
      </AppearanceProvider>
    );
    expect(frame).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<span[^>]*>02<\/span>[^<]*<span[^>]*>Sessions<\/span>/u);
    expect(frame).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<span[^>]*>03<\/span>[^<]*<span[^>]*>Settings<\/span>/u);
    expect(frame).toMatch(
      /class="product-frame__new"[^>]*disabled=""[^>]*title="Resume or finish the paused interview before starting a new interview\."/u
    );

    const home = renderToStaticMarkup(
      <HomePage
        activeSessionId={activeSession}
        activeSessionCount={1}
        activeSessionPaused
        sessions={[
          {
            sessionId: activeSession,
            problemId: "active",
            problemVersion: "1",
            status: "ACTIVE",
            sequence: 2,
            createdAt: "2026-09-04T20:00:00.000Z",
            updatedAt: "2026-09-04T20:01:00.000Z",
            eventCount: 2
          },
          {
            sessionId: completedSession,
            problemId: "complete",
            problemVersion: "1",
            status: "COMPLETED",
            sequence: 3,
            createdAt: "2026-09-04T19:00:00.000Z",
            updatedAt: "2026-09-04T19:30:00.000Z",
            eventCount: 3
          }
        ]}
        onStartInterview={vi.fn()}
        onResumeInterview={vi.fn()}
        onOpenSessions={vi.fn()}
        onOpenSettings={vi.fn()}
        canReview={(session) => session.status === "COMPLETED"}
        onReview={vi.fn()}
        sessionEntryPending={false}
      />
    );

    expect(home).toMatch(/class="expressive-home__secondary"[^>]*disabled=""/u);
    expect(home).toMatch(/>See all →<\/button>/u);
    expect(home).toMatch(/<button[^>]*disabled=""[^>]*title="Resume or finish the paused interview before opening another session\."[^>]*>Review<\/button>/u);
    expect(home).toMatch(/<button[^>]*>Resume<\/button>/u);
  });

  it("contains stale voice-control promise rejections during lifecycle races", () => {
    const voice = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/VoiceControls.tsx"),
      "utf8"
    );

    expect(voice).toContain("controls.enableMicrophone()");
    expect(voice).toContain(").catch(() => undefined);");
    expect(voice).toContain(
      "controls.selectInputDevice(deviceId).catch(() => undefined)"
    );
    expect(voice).toContain("onSelect: (deviceId: string | undefined) => void | Promise<void>");
    expect(voice).toContain("Promise.resolve(onSelect(deviceId)).catch(() => undefined)");
    expect(voice).toContain("selectOption(option.deviceId)");
    expect(voice).toContain("onSelect={controls.selectOutputDevice}");
  });

  it("contains rejected quant refresh reads instead of creating unhandled promises", () => {
    for (const sourcePath of [
      "apps/web/src/quant/QuantTradingWorkspace.tsx",
      "apps/web/src/quant/QuantResearchWorkspace.tsx"
    ]) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), sourcePath),
        "utf8"
      );
      expect(source).not.toContain("onClick={() => void onRefresh()}");
      expect(source).toContain("onRefresh().catch(() => undefined)");
    }

    const quantShell = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/quant/QuantSessionWorkspace.tsx"),
      "utf8"
    );
    expect(quantShell).toContain("data-connected={String(connected)}");
    expect(quantShell).toContain('connected ? "Deterministic state" : "Disconnected"');
  });
  it("states that duration is a planning reminder rather than a cutoff", () => {
    const markup = renderToStaticMarkup(
      <NewInterviewPage
        catalog={[{
          mode: "OXFORD_MATHEMATICS",
          id: "duration-semantics",
          version: "1",
          title: "Duration semantics",
          category: "proof",
          difficulty: "standard"
        }]}
        catalogLoading={false}
        catalogError={null}
        providerOptions={[{
          providerId: "test-provider",
          providerDisplayName: "Test Provider",
          providerKind: "MOCK",
          modelId: "test-model",
          modelDisplayName: "Test Model",
          availability: "AVAILABLE"
        }]}
        providerOptionsLoading={false}
        providerOptionsError={null}
        activeSessionId={null}
        activeSessionCount={0}
        startPending={false}
        onRefreshCatalog={async () => []}
        onRefreshProviderOptions={async () => []}
        onStart={async () => undefined}
        onResumeActive={null}
      />
    );
    expect(markup).toContain(
      "Planning reminder only; the interview will not end automatically."
    );
  });

  it("freezes launch configuration while session entry is pending", () => {
    const markup = renderToStaticMarkup(
      <NewInterviewPage
        catalog={[{
          mode: "OXFORD_MATHEMATICS",
          id: "pending-launch",
          version: "1",
          title: "Pending launch",
          category: "proof",
          difficulty: "standard"
        }]}
        catalogLoading={false}
        catalogError={null}
        providerOptions={[{
          providerId: "test-provider",
          providerDisplayName: "Test Provider",
          providerKind: "MOCK",
          modelId: "test-model",
          modelDisplayName: "Test Model",
          availability: "AVAILABLE"
        }]}
        providerOptionsLoading={false}
        providerOptionsError={null}
        activeSessionId={null}
        activeSessionCount={0}
        startPending
        onRefreshCatalog={async () => []}
        onRefreshProviderOptions={async () => []}
        onStart={async () => undefined}
        onResumeActive={null}
      />
    );

    expect(markup).toMatch(/<select(?=[^>]*data-testid="interview-target-select")(?=[^>]*disabled="")[^>]*>/u);
    expect(markup).toMatch(/<input(?=[^>]*data-testid="duration-input")(?=[^>]*disabled="")[^>]*>/u);
    expect(markup).toMatch(/<select(?=[^>]*data-testid="provider-select")(?=[^>]*disabled="")[^>]*>/u);
    expect(markup).toMatch(/<button(?=[^>]*data-testid="intervention-balanced")(?=[^>]*disabled="")[^>]*>/u);
    expect(markup).toMatch(/<button(?=[^>]*data-testid="start-configured-session-btn")(?=[^>]*disabled)[^>]*>/u);
  });

  it("fails closed when stored session authority cannot be verified", () => {
    const home = renderToStaticMarkup(
      <HomePage
        activeSessionId={null}
        activeSessionCount={0}
        sessions={[]}
        onStartInterview={vi.fn()}
        onResumeInterview={vi.fn()}
        onOpenSessions={vi.fn()}
        onOpenSettings={vi.fn()}
        canReview={() => false}
        onReview={vi.fn()}
        sessionEntryPending={false}
        sessionAuthorityUnavailable
      />
    );
    expect(home).toContain("Stored session authority is unavailable");
    expect(home).toMatch(/<button(?=[^>]*data-testid="start-session-btn")(?=[^>]*disabled="")[^>]*>/u);

    const configure = renderToStaticMarkup(
      <NewInterviewPage
        catalog={[{
          mode: "OXFORD_MATHEMATICS",
          id: "authority-failure",
          version: "1",
          title: "Authority failure",
          category: "proof",
          difficulty: "standard"
        }]}
        catalogLoading={false}
        catalogError={null}
        providerOptions={[{
          providerId: "test-provider",
          providerDisplayName: "Test Provider",
          providerKind: "MOCK",
          modelId: "test-model",
          modelDisplayName: "Test Model",
          availability: "AVAILABLE"
        }]}
        providerOptionsLoading={false}
        providerOptionsError={null}
        activeSessionId={null}
        activeSessionCount={0}
        startPending={false}
        sessionAuthorityUnavailable
        onRefreshCatalog={async () => []}
        onRefreshProviderOptions={async () => []}
        onStart={async () => undefined}
        onResumeActive={null}
      />
    );
    expect(configure).toContain("Stored session authority unavailable");
    expect(configure).toMatch(
      /<button(?=[^>]*data-testid="start-configured-session-btn")(?=[^>]*disabled)[^>]*>/u
    );

    const settings = renderToStaticMarkup(
      <AppearanceProvider>
        <SettingsPage
          providerOptions={[{
            providerId: "ready-provider",
            providerDisplayName: "Ready Provider",
            providerKind: "REMOTE_API",
            modelId: "ready-model",
            modelDisplayName: "Ready Model",
            availability: "AVAILABLE"
          }]}
          providerOptionsLoading={false}
          providerOptionsError={null}
          activeSessionCount={0}
          sessionAuthorityUnavailable
          onRefreshProviderOptions={async () => []}
          onStartInterview={vi.fn()}
        />
      </AppearanceProvider>
    );
    expect(settings).toContain("Stored session authority could not be verified.");
    expect(settings).toMatch(
      /<button[^>]*disabled=""[^>]*>Start interview<\/button>/u
    );

    const sessions = renderToStaticMarkup(
      <SessionsPage
        sessions={[]}
        currentSessionId={null}
        canReview={() => false}
        onResume={vi.fn()}
        onReview={vi.fn()}
        onRefresh={vi.fn()}
        history={null}
        historyLoading={false}
        historyError={null}
        sessionAuthorityUnavailable
      />
    );
    expect(sessions).toContain("Stored session list could not be verified.");
    expect(sessions).toContain("Refresh");

    const hook = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/hooks/useInterviewSession.ts"),
      "utf8"
    );
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    expect(hook).toContain("verifyAvailableSessions");
    expect(app).toContain("setSessionAuthorityUnavailable(true)");
    expect(app).toContain("session.verifyAvailableSessions()");
  });

  it("locks shared product navigation while a session entry transition is pending", async () => {
    await act(async () => {
      root?.render(
        <AppearanceProvider>
          <ProductFrame
            activePage={null}
            title="New interview"
            kicker="Configure the room"
            onNavigate={vi.fn()}
            transitionLocked
          >
            content
          </ProductFrame>
        </AppearanceProvider>
      );
    });

    const railButtons = Array.from(
      document.querySelectorAll(".product-frame__rail button")
    );
    expect(railButtons.length).toBeGreaterThan(0);
    for (const button of railButtons) {
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Product rail action was not a button");
      }
      expect(button.disabled).toBe(true);
    }
    expect(document.querySelector(".product-frame")?.getAttribute("aria-busy"))
      .toBe("true");

    for (const stylesheet of [
      "apps/web/src/components/ProductFrame.css",
      "apps/web/src/styles/editorial-v10.css"
    ]) {
      const css = fs.readFileSync(path.resolve(process.cwd(), stylesheet), "utf8");
      expect(css).toContain(".product-frame__brand:hover:not(:disabled)");
      expect(css).toContain(".product-frame__new:hover:not(:disabled)");
      expect(css).toContain(".product-frame__brand:disabled");
      expect(css).toContain(".product-frame__new:disabled");
    }
  });

});
