import type { ReactNode } from "react";
import type {
  SessionId,
  StoredSessionSummary
} from "../../../../packages/domain/src/index.js";
import type {
  SessionHistoryReadResponse
} from "../../../../packages/replay/src/index.js";
import { ProductFrame, type ProductPageId } from "../components/ProductFrame.js";
import { HomePage } from "../pages/HomePage.js";
import { ReviewPageShell, type ReviewView } from "../pages/ReviewPageShell.js";
import { SessionsPage } from "../pages/SessionsPage.js";
import { SettingsPage } from "../pages/SettingsPage.js";
import type { ProductRoute } from "./product-route.js";

export function ProductPageRouter({
  route,
  sessions,
  activeSessionId,
  currentSessionId,
  activeProblemTitle,
  activeSessionPaused,
  canReview,
  sessionEntryPending,
  onNavigatePage,
  onEnterInterview,
  onResume,
  onReview,
  onRefreshSessions,
  history,
  historyLoading,
  historyError,
  connection,
  notice,
  onDismissNotice,
  renderReview
}: {
  readonly route: Exclude<ProductRoute, { readonly page: "interview" }>;
  readonly sessions: readonly StoredSessionSummary[];
  readonly activeSessionId: SessionId | null;
  readonly currentSessionId: SessionId | null;
  readonly activeProblemTitle?: string | null;
  readonly activeSessionPaused?: boolean;
  readonly canReview: (session: StoredSessionSummary) => boolean;
  readonly sessionEntryPending: boolean;
  readonly onNavigatePage: (page: ProductPageId) => void;
  readonly onEnterInterview: () => void;
  readonly onResume: (sessionId: SessionId) => void;
  readonly onReview: (
    sessionId: SessionId,
    view: ReviewView,
    options?: { readonly replace?: boolean }
  ) => void;
  readonly onRefreshSessions: () => void;
  readonly history: SessionHistoryReadResponse | null;
  readonly historyLoading: boolean;
  readonly historyError: string | null;
  readonly connection?: {
    readonly managed: boolean;
    readonly baseUrl: string;
    readonly locked: boolean;
    readonly onSaveBaseUrl: (baseUrl: string) => void;
  };
  readonly notice?: string | null;
  readonly onDismissNotice?: (() => void) | undefined;
  readonly renderReview: (
    sessionId: SessionId,
    view: ReviewView
  ) => ReactNode;
}) {
  let title: string;
  let kicker: string;
  let activePage: ProductPageId | null;
  let content: ReactNode;

  switch (route.page) {
    case "home":
      title = "Home";
      kicker = "Interview room";
      activePage = "home";
      content = (
        <HomePage
          activeSessionId={activeSessionId}
          activeProblemTitle={activeProblemTitle ?? null}
          activeSessionPaused={activeSessionPaused ?? false}
          sessions={sessions}
          onStartInterview={onEnterInterview}
          onResumeInterview={onResume}
          onOpenSessions={() => onNavigatePage("sessions")}
          onOpenSettings={() => onNavigatePage("settings")}
          canReview={canReview}
          sessionEntryPending={sessionEntryPending}
          onReview={(sessionId) => onReview(sessionId, "evaluation")}
        />
      );
      break;
    case "sessions":
      title = "Sessions";
      kicker = "Local ledger";
      activePage = "sessions";
      content = (
        <SessionsPage
          sessions={sessions}
          currentSessionId={currentSessionId}
          canReview={canReview}
          onResume={onResume}
          onReview={(sessionId) => onReview(sessionId, "evaluation")}
          onRefresh={onRefreshSessions}
          history={history}
          historyLoading={historyLoading}
          historyError={historyError}
        />
      );
      break;
    case "settings":
      title = "Settings";
      kicker = "Room tuning";
      activePage = "settings";
      content = (
        <SettingsPage
          {...(connection === undefined ? {} : { connection })}
        />
      );
      break;
    case "review":
      title = "Review";
      kicker = "Post-interview";
      activePage = null;
      content = (
        <ReviewPageShell
          view={route.view}
          onViewChange={(view) =>
            onReview(route.sessionId, view, { replace: true })
          }
          onBack={() => onNavigatePage("sessions")}
          evaluation={renderReview(route.sessionId, "evaluation")}
          replay={renderReview(route.sessionId, "replay")}
        />
      );
      break;
  }

  return (
    <ProductFrame
      activePage={activePage}
      title={title}
      kicker={kicker}
      onNavigate={onNavigatePage}
      notice={notice}
      onDismissNotice={onDismissNotice}
    >
      {content}
    </ProductFrame>
  );
}
