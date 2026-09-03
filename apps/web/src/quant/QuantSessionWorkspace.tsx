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
  const actionPendingRef = useRef(quantActionPending);
  useEffect(() => {
    actionPendingRef.current = quantActionPending;
  }, [quantActionPending]);

  useEffect(() => {
    if (
      productHidden
      || paused
      || sessionStatus !== "ACTIVE"
    ) return;

    const refresh = (): void => {
      if (actionPendingRef.current) return;
      void onRefresh().catch(() => undefined);
    };
    refresh();

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    onRefresh,
    paused,
    productHidden,
    sessionStatus
  ]);

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
