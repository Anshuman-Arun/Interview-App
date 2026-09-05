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
      /data-testid="start-configured-session-btn"[^>]*disabled/
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
      "The bounded evaluation read could not be loaded."
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
    expect(host?.textContent).toContain("Loading bounded evaluation…");
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
      "The bounded replay read could not be loaded."
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
    expect(host?.textContent).not.toContain("bounded replay read could not be loaded");
    expect(readEvaluation).toHaveBeenCalledTimes(1);
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
    expect(app).toMatch(
      /route\.page === "home"[\s\S]{0,120}route\.page === "new"[\s\S]{0,120}route\.page === "settings"[\s\S]{0,180}fetchAvailableSessions/u
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
    expect(transcriptCss).toContain(
      "@media(max-width:960px){.transcript-feed__focus{display:none}}"
    );
    expect(transcriptCss).not.toContain(
      ".transcript-feed__jump,.transcript-feed__focus{display:none}"
    );
    expect(appCss).toContain(
      ".app-header__board-state[data-sync=UNSYNCHRONIZED]>span{background:var(--danger)}"
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
});
