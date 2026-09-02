import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  SessionIdSchema,
  type StoredSessionSummary
} from "../packages/domain/src/index.js";
import { AppPageFrame } from "../apps/web/src/components/AppPageFrame.js";
import { HomePage } from "../apps/web/src/pages/HomePage.js";
import { SessionsPage } from "../apps/web/src/pages/SessionsPage.js";
import { SettingsPage } from "../apps/web/src/pages/SettingsPage.js";
import { SessionReviewPage } from "../apps/web/src/pages/SessionReviewPage.js";

const ACTIVE_SESSION_ID = SessionIdSchema.parse(
  "session_00000000-0000-4000-8000-000000000021"
);
const COMPLETE_SESSION_ID = SessionIdSchema.parse(
  "session_00000000-0000-4000-8000-000000000022"
);

const SESSIONS: readonly StoredSessionSummary[] = [
  {
    sessionId: ACTIVE_SESSION_ID,
    problemId: "oxford-six-people",
    problemVersion: "1",
    status: "ACTIVE",
    sequence: 12,
    createdAt: "2026-09-01T20:00:00.000Z",
    updatedAt: "2026-09-01T20:10:00.000Z",
    eventCount: 12
  },
  {
    sessionId: COMPLETE_SESSION_ID,
    problemId: "oxford-six-people",
    problemVersion: "1",
    status: "COMPLETED",
    sequence: 42,
    createdAt: "2026-08-31T20:00:00.000Z",
    updatedAt: "2026-08-31T20:40:00.000Z",
    eventCount: 42
  }
];

describe("dedicated product pages", () => {
  it("renders compact application navigation without putting it in the interview shell", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        AppPageFrame,
        {
          activePage: "sessions",
          title: "Sessions",
          description: "Local history",
          onNavigate: vi.fn(),
          notice: "Command connection failed",
          onDismissNotice: vi.fn(),
          children: React.createElement("div", null, "content")
        }
      )
    );

    expect(markup).toContain('aria-label="Application"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain(">Home<");
    expect(markup).toContain(">Sessions<");
    expect(markup).toContain(">Settings<");
    expect(markup).toContain("Command connection failed");
    expect(markup).toContain('aria-label="Dismiss notice"');
  });

  it("uses active-session-aware Home actions", () => {
    const activeMarkup = renderToStaticMarkup(
      React.createElement(HomePage, {
        activeSessionId: ACTIVE_SESSION_ID,
        activeProblemTitle: "Six People",
        sessions: SESSIONS,
        onStartInterview: vi.fn(),
        onResumeInterview: vi.fn(),
        onReviewSession: vi.fn(),
        onOpenSessions: vi.fn()
      })
    );
    expect(activeMarkup).toContain("Your interview is still active.");
    expect(activeMarkup).toContain("Resume interview");
    expect(activeMarkup).not.toContain(">Start interview<");

    const idleMarkup = renderToStaticMarkup(
      React.createElement(HomePage, {
        activeSessionId: null,
        sessions: SESSIONS.filter((item) => item.status !== "ACTIVE"),
        onStartInterview: vi.fn(),
        onResumeInterview: vi.fn(),
        onReviewSession: vi.fn(),
        onOpenSessions: vi.fn()
      })
    );
    expect(idleMarkup).toContain("Start a focused technical interview.");
    expect(idleMarkup).toContain(">Start interview<");
  });

  it("locks new-session creation on Sessions while an interview is active", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SessionsPage, {
        sessions: SESSIONS,
        currentSessionId: ACTIVE_SESSION_ID,
        history: null,
        historyLoading: false,
        historyError: null,
        canStartInterview: false,
        onRefresh: vi.fn(),
        onStartInterview: vi.fn(),
        onResume: vi.fn(),
        onReview: vi.fn()
      })
    );

    expect(markup).toContain('aria-label="Session status"');
    expect(markup).toContain('id="session-search"');
    expect(markup).toContain("Finish or archive the active interview before starting another");
    expect(markup).toContain("disabled");
  });

  it("renders only real appearance and connection settings", () => {
    const managed = renderToStaticMarkup(
      React.createElement(SettingsPage, {
        baseUrl: "http://127.0.0.1:43123",
        isTransportManaged: true,
        connectionLocked: false,
        onSaveBaseUrl: vi.fn()
      })
    );
    expect(managed).toContain("Appearance");
    expect(managed).toContain("Desktop managed");
    expect(managed).not.toContain("Provider");
    expect(managed).not.toContain("Model");

    const lockedBrowser = renderToStaticMarkup(
      React.createElement(SettingsPage, {
        baseUrl: "http://127.0.0.1:43123",
        isTransportManaged: false,
        connectionLocked: true,
        onSaveBaseUrl: vi.fn()
      })
    );
    expect(lockedBrowser).toContain("Connection changes are locked while an interview is active.");
    expect(lockedBrowser).toContain('id="settings-command-url"');
    expect(lockedBrowser).toContain("disabled");
  });

  it("renders review as a dedicated tabbed page without reading data during SSR", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SessionReviewPage, {
        sessionId: COMPLETE_SESSION_ID,
        initialTab: "evaluation",
        readEvaluation: vi.fn(),
        readReplay: vi.fn(),
        onBack: vi.fn()
      })
    );

    expect(markup).toContain("Back to sessions");
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain(">Evaluation<");
    expect(markup).toContain(">Replay<");
    expect(markup).toContain(COMPLETE_SESSION_ID);
  });
});
