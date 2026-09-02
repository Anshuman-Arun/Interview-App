import React from "react";
import type {
  SessionId,
  StoredSessionSummary
} from "../../../../packages/domain/src/index.js";
import type {
  SessionEvaluationReadResponse,
  SessionHistoryReadResponse,
  SessionReplayReadResponse
} from "../../../../packages/replay/src/index.js";
import {
  AppPageFrame,
  type ProductNavPage
} from "../components/AppPageFrame.js";
import type { AppRoute } from "../navigation/app-route.js";
import { HomePage } from "./HomePage.js";
import { SessionReviewPage } from "./SessionReviewPage.js";
import { SessionsPage } from "./SessionsPage.js";
import { SettingsPage } from "./SettingsPage.js";

export type ProductRoute = Exclude<AppRoute, { readonly page: "interview" }>;
export type { ProductNavPage } from "../components/AppPageFrame.js";

export interface ProductPageRouterProps {
  readonly route: ProductRoute;
  readonly sessions: readonly StoredSessionSummary[];
  readonly currentSessionId: SessionId | null;
  readonly history: SessionHistoryReadResponse | null;
  readonly historyLoading: boolean;
  readonly historyError: string | null;
  readonly baseUrl: string;
  readonly isTransportManaged: boolean;
  readonly notice: string | null;
  readonly onDismissNotice: () => void;
  readonly onNavigate: (page: ProductNavPage) => void;
  readonly onStartInterview: () => void | Promise<void>;
  readonly onResumeInterview: (sessionId: SessionId) => void | Promise<void>;
  readonly onRefreshSessions: () => void;
  readonly onSaveBaseUrl: (baseUrl: string) => void;
  readonly onReviewRoute: (
    sessionId: SessionId,
    tab: "evaluation" | "replay",
    options?: { readonly replace?: boolean }
  ) => void;
  readonly readEvaluation: (
    sessionId: SessionId,
    signal?: AbortSignal
  ) => Promise<SessionEvaluationReadResponse>;
  readonly readReplay: (
    sessionId: SessionId,
    signal?: AbortSignal
  ) => Promise<SessionReplayReadResponse>;
}

export const ProductPageRouter: React.FC<ProductPageRouterProps> = ({
  route,
  sessions,
  currentSessionId,
  history,
  historyLoading,
  historyError,
  baseUrl,
  isTransportManaged,
  notice,
  onDismissNotice,
  onNavigate,
  onStartInterview,
  onResumeInterview,
  onRefreshSessions,
  onSaveBaseUrl,
  onReviewRoute,
  readEvaluation,
  readReplay
}) => {
  const activePage: ProductNavPage | null =
    route.page === "home" || route.page === "sessions" || route.page === "settings"
      ? route.page
      : null;

  let pageTitle: string;
  let pageDescription: string;
  let pageContent: React.ReactNode;

  switch (route.page) {
    case "home":
      pageTitle = "Home";
      pageDescription = "Start, resume, and review local technical interviews.";
      pageContent = (
        <HomePage
          activeSessionId={null}
          activeProblemTitle={null}
          sessions={sessions}
          onStartInterview={onStartInterview}
          onResumeInterview={onResumeInterview}
          onReviewSession={(sessionId) => {
            onReviewRoute(sessionId, "evaluation");
          }}
          onOpenSessions={() => onNavigate("sessions")}
        />
      );
      break;
    case "sessions":
      pageTitle = "Sessions";
      pageDescription = "Local interview history and grounded cross-session evaluation.";
      pageContent = (
        <SessionsPage
          sessions={sessions}
          currentSessionId={currentSessionId}
          history={history}
          historyLoading={historyLoading}
          historyError={historyError}
          canStartInterview={true}
          onRefresh={onRefreshSessions}
          onStartInterview={onStartInterview}
          onResume={onResumeInterview}
          onReview={(sessionId) => {
            onReviewRoute(sessionId, "evaluation");
          }}
        />
      );
      break;
    case "settings":
      pageTitle = "Settings";
      pageDescription = "Local appearance and connection preferences.";
      pageContent = (
        <SettingsPage
          baseUrl={baseUrl}
          isTransportManaged={isTransportManaged}
          connectionLocked={false}
          onSaveBaseUrl={onSaveBaseUrl}
        />
      );
      break;
    case "review":
      pageTitle = "Session review";
      pageDescription = "Grounded evaluation and authoritative replay.";
      pageContent = (
        <SessionReviewPage
          sessionId={route.sessionId}
          initialTab={route.tab ?? "evaluation"}
          readEvaluation={readEvaluation}
          readReplay={readReplay}
          onBack={() => onNavigate("sessions")}
          onTabChange={(tab) => {
            onReviewRoute(route.sessionId, tab, { replace: true });
          }}
        />
      );
      break;
  }

  return (
    <AppPageFrame
      activePage={activePage}
      title={pageTitle}
      description={pageDescription}
      notice={notice}
      onDismissNotice={onDismissNotice}
      onNavigate={onNavigate}
    >
      {pageContent}
    </AppPageFrame>
  );
};
