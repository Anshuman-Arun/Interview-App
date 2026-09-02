import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  SessionIdSchema,
  type StoredSessionSummary
} from "../packages/domain/src/index.js";
import { AppearanceProvider } from "../apps/web/src/appearance/AppearanceProvider.js";
import { ProductFrame } from "../apps/web/src/components/ProductFrame.js";
import { HomePage } from "../apps/web/src/pages/HomePage.js";
import { SessionsPage } from "../apps/web/src/pages/SessionsPage.js";
import { ReviewPageShell } from "../apps/web/src/pages/ReviewPageShell.js";

const ACTIVE = SessionIdSchema.parse(
  "session_00000000-0000-4000-8000-000000000101"
);
const COMPLETE = SessionIdSchema.parse(
  "session_00000000-0000-4000-8000-000000000102"
);

const sessions: readonly StoredSessionSummary[] = [
  {
    sessionId: ACTIVE,
    problemId: "oxford-demo",
    problemVersion: "1.0.0",
    status: "ACTIVE",
    sequence: 10,
    createdAt: "2026-09-01T20:00:00.000Z",
    updatedAt: "2026-09-01T20:20:00.000Z",
    eventCount: 10
  },
  {
    sessionId: COMPLETE,
    problemId: "oxford-demo",
    problemVersion: "1.0.0",
    status: "COMPLETED",
    sequence: 35,
    createdAt: "2026-08-31T20:00:00.000Z",
    updatedAt: "2026-08-31T20:45:00.000Z",
    eventCount: 35
  }
];

describe("expressive product page layer", () => {
  it("renders indexed product navigation instead of generic dashboard chrome", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        AppearanceProvider,
        null,
        React.createElement(ProductFrame, {
          activePage: "home",
          title: "Home",
          kicker: "Interview room",
          onNavigate: vi.fn(),
          children: React.createElement("div", null, "content")
        })
      )
    );

    expect(markup).toContain("01");
    expect(markup).toContain("02");
    expect(markup).toContain("03");
    expect(markup).toContain("VOICE · BOARD · REPLAY");
  });

  it("renders an active-room-aware editorial home surface", () => {
    const markup = renderToStaticMarkup(
      React.createElement(HomePage, {
        activeSessionId: ACTIVE,
        activeProblemTitle: "Divisibility chains",
        sessions,
        onStartInterview: vi.fn(),
        onResumeInterview: vi.fn(),
        onOpenSessions: vi.fn(),
        onOpenSettings: vi.fn(),
        canReview: (session) => session.status === "COMPLETED",
        onReview: vi.fn()
      })
    );

    expect(markup).toContain("Think on the page.");
    expect(markup).toContain("Talk through the proof.");
    expect(markup).toContain("Return to room");
    expect(markup).toContain("Divisibility chains");
    expect(markup).not.toContain(">Enter interview<");
  });

  it("renders a searchable ledger with grounded action ownership supplied by the caller", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SessionsPage, {
        sessions,
        currentSessionId: ACTIVE,
        canReview: (session) => session.status === "COMPLETED",
        onResume: vi.fn(),
        onReview: vi.fn(),
        onRefresh: vi.fn(),
        history: null,
        historyLoading: false,
        historyError: null
      })
    );

    expect(markup).toContain("A ledger, not a dashboard.");
    expect(markup).toContain("Current");
    expect(markup).toContain("Review");
  });

  it("keeps review presentation independent of product-read implementation", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ReviewPageShell, {
        sessionId: COMPLETE,
        view: "evaluation",
        onViewChange: vi.fn(),
        onBack: vi.fn(),
        evaluation: React.createElement("div", null, "evaluation-content"),
        replay: React.createElement("div", null, "replay-content")
      })
    );

    expect(markup).toContain("Review the reasoning, not just the score.");
    expect(markup).toContain("evaluation-content");
    expect(markup).not.toContain("replay-content");
  });
});
