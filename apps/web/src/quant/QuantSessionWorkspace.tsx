import React, { useEffect, useRef } from "react";
import type {
  InterviewSessionConfiguration,
  QuantResearchCandidateAction,
  QuantResearchPublicState,
  QuantTradingCandidateAction,
  QuantTradingPublicState,
  SessionStatus
} from "../../../../packages/domain/src/index.js";
import { AppearanceDock } from "../components/AppearanceDock.js";
import { BrandMark } from "../components/BrandMark.js";
import { QuantResearchWorkspace } from "./QuantResearchWorkspace.js";
import { QuantTradingWorkspace } from "./QuantTradingWorkspace.js";
import type { QuantSessionPublicState } from "../hooks/useInterviewSession.js";
import "../styles/quant.css";

export interface QuantSessionWorkspaceProps {
  readonly configuration: Extract<InterviewSessionConfiguration, { mode: "QUANT_TRADING" | "QUANT_RESEARCH" }>;
  readonly quantState: QuantSessionPublicState | null;
  readonly quantStateLoading: boolean;
  readonly quantActionPending: boolean;
  readonly sessionStatus: SessionStatus;
  readonly paused: boolean;
  readonly productHidden: boolean;
  readonly notice: string | null;
  readonly onDismissNotice: () => void;
  readonly onHome: () => void;
  readonly onReview: () => void;
  readonly onRefresh: () => Promise<QuantSessionPublicState | null>;
  readonly onSubmitTrading: (action: QuantTradingCandidateAction) => Promise<QuantTradingPublicState>;
  readonly onSubmitResearch: (action: QuantResearchCandidateAction) => Promise<QuantResearchPublicState>;
}

export const QuantSessionWorkspace: React.FC<QuantSessionWorkspaceProps> = ({
  configuration,
  quantState,
  quantStateLoading,
  quantActionPending,
  sessionStatus,
  paused,
  productHidden,
  notice,
  onDismissNotice,
  onHome,
  onReview,
  onRefresh,
  onSubmitTrading,
  onSubmitResearch
}) => {
  const presentationActive =
    !productHidden
    && !paused
    && sessionStatus === "ACTIVE";
  const actionPendingRef = useRef(quantActionPending);
  const presentationActiveRef = useRef(presentationActive);
  const lifecycleInitializedRef = useRef(false);
  const deferredRefreshRef = useRef(false);

  useEffect(() => {
    const wasPending = actionPendingRef.current;
    const wasPresentationActive = presentationActiveRef.current;
    actionPendingRef.current = quantActionPending;
    presentationActiveRef.current = presentationActive;

    if (!presentationActive) {
      if (quantActionPending || wasPending) {
        deferredRefreshRef.current = true;
      }
      return;
    }

    if (quantActionPending) {
      if (!wasPresentationActive) {
        deferredRefreshRef.current = true;
      }
      lifecycleInitializedRef.current = true;
      return;
    }

    const shouldRefresh =
      !lifecycleInitializedRef.current
      || !wasPresentationActive
      || (wasPending && deferredRefreshRef.current);
    lifecycleInitializedRef.current = true;
    if (!shouldRefresh) return;

    deferredRefreshRef.current = false;
    void onRefresh().catch(() => undefined);
  }, [
    onRefresh,
    presentationActive,
    quantActionPending
  ]);

  useEffect(() => {
    if (!presentationActive) return;

    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") return;
      if (actionPendingRef.current) {
        deferredRefreshRef.current = true;
        return;
      }
      void onRefresh().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [onRefresh, presentationActive]);

  const modeLabel = configuration.mode === "QUANT_TRADING" ? "Quant Trading" : "Quant Research";
  const disabled = paused || sessionStatus !== "ACTIVE";

  return (
    <div
      hidden={productHidden}
      className="quant-session-shell"
      data-testid="quant-session-workspace"
      data-mode={configuration.mode}
    >
      <header className="app-header quant-header">
        <button
          type="button"
          className="app-header__identity"
          onClick={onHome}
          disabled={quantActionPending}
          aria-label="Pause interview and open Home"
        >
          <BrandMark size={28} title="Interview" />
          <span className="app-header__identity-copy">
            <strong>{modeLabel}</strong>
            <small>{configuration.scenario.id}</small>
          </span>
        </button>
        <div className="app-header__actions">
          <span className="app-header__connection" data-connected="true">
            <span aria-hidden="true" />
            Deterministic state
          </span>
          <button
            type="button"
            onClick={onHome}
            disabled={quantActionPending}
            className="app-header__quiet"
          >
            Home
          </button>
          <AppearanceDock compact />
        </div>
      </header>

      {notice !== null && (
        <div className="quant-notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={onDismissNotice} aria-label="Dismiss notice">×</button>
        </div>
      )}

      {configuration.mode === "QUANT_TRADING" ? (
        <QuantTradingWorkspace
          state={quantState?.mode === "QUANT_TRADING" ? quantState.state : null}
          loading={quantStateLoading}
          actionPending={quantActionPending}
          disabled={disabled || quantStateLoading}
          onRefresh={onRefresh}
          onSubmit={onSubmitTrading}
          onReview={onReview}
        />
      ) : (
        <QuantResearchWorkspace
          state={quantState?.mode === "QUANT_RESEARCH" ? quantState.state : null}
          loading={quantStateLoading}
          actionPending={quantActionPending}
          disabled={disabled || quantStateLoading}
          onRefresh={onRefresh}
          onSubmit={onSubmitResearch}
          onReview={onReview}
        />
      )}
    </div>
  );
};
