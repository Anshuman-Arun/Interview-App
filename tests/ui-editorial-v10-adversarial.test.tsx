// @vitest-environment happy-dom
import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../apps/web/src/appearance/AppearanceProvider.js";
import { ProductFrame } from "../apps/web/src/components/ProductFrame.js";
import {
  TranscriptFeed,
  type TranscriptItem
} from "../apps/web/src/components/TranscriptFeed.js";
import { HomePage } from "../apps/web/src/pages/HomePage.js";
import { NewInterviewPage } from "../apps/web/src/pages/NewInterviewPage.js";

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
    expect(home).toContain("Resolve active sessions");
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
    expect(app).toMatch(
      /app-header__board-state"[\s\S]{0,100}data-sync=\{session\.whiteboardSync\.status\}/u
    );

    expect(frameCss).not.toContain(".product-frame__nav::before");
    expect(editorialCss).toContain(".board-appbar__layout-action");
    expect(editorialCss).not.toContain(
      ".live-pane-heading button,\n  .board-appbar__actions button {\n    display: none;"
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
  });
});
