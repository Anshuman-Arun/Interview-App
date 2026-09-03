import React, { useMemo, useState } from "react";
import type {
  QuantTradingCandidateAction,
  QuantTradingPublicState
} from "../../../../packages/domain/src/index.js";

export interface QuantTradingWorkspaceProps {
  readonly state: QuantTradingPublicState | null;
  readonly loading: boolean;
  readonly actionPending: boolean;
  readonly disabled: boolean;
  readonly onRefresh: () => Promise<unknown>;
  readonly onSubmit: (action: QuantTradingCandidateAction) => Promise<QuantTradingPublicState>;
  readonly onReview: () => void;
}

function displayNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function isOnTick(value: number, tickSize: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(tickSize) || tickSize <= 0) return false;
  const units = value / tickSize;
  return Number.isFinite(units) && Math.abs(units - Math.round(units)) <= 1e-9;
}

function parseFinite(raw: string): number | null {
  if (raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parsePositiveInteger(raw: string): number | null {
  const value = parseFinite(raw);
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export const QuantTradingWorkspace: React.FC<QuantTradingWorkspaceProps> = ({
  state,
  loading,
  actionPending,
  disabled,
  onRefresh,
  onSubmit,
  onReview
}) => {
  const [bidPrice, setBidPrice] = useState("");
  const [bidSize, setBidSize] = useState("");
  const [askPrice, setAskPrice] = useState("");
  const [askSize, setAskSize] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const validation = useMemo(() => {
    if (state?.status !== "ACTIVE" || state.quoteRequest === undefined) {
      return { action: null, error: null } as const;
    }
    const parsedBidPrice = parseFinite(bidPrice);
    const parsedAskPrice = parseFinite(askPrice);
    const parsedBidSize = parsePositiveInteger(bidSize);
    const parsedAskSize = parsePositiveInteger(askSize);
    if ([bidPrice, bidSize, askPrice, askSize].every((value) => value.trim().length === 0)) {
      return { action: null, error: null } as const;
    }
    if (parsedBidPrice === null || parsedAskPrice === null || parsedBidPrice <= 0 || parsedAskPrice <= 0) {
      return { action: null, error: "Bid and ask prices must be positive finite numbers." } as const;
    }
    if (parsedBidSize === null || parsedAskSize === null) {
      return { action: null, error: "Quote sizes must be positive whole numbers." } as const;
    }
    if (parsedBidPrice >= parsedAskPrice) {
      return { action: null, error: "Bid must be strictly below ask." } as const;
    }
    if (!isOnTick(parsedBidPrice, state.quoteRequest.tickSize) || !isOnTick(parsedAskPrice, state.quoteRequest.tickSize)) {
      return {
        action: null,
        error: `Prices must lie on the public tick size of ${displayNumber(state.quoteRequest.tickSize)}.`
      } as const;
    }
    if (
      parsedBidSize > state.quoteRequest.maxQuoteSize
      || parsedAskSize > state.quoteRequest.maxQuoteSize
    ) {
      return {
        action: null,
        error: `Each size must be at most ${String(state.quoteRequest.maxQuoteSize)}.`
      } as const;
    }
    if (state.quoteRequest.hardPositionLimit) {
      const position = state.portfolio.position;
      if (
        position + parsedBidSize > state.quoteRequest.maxPosition
        || position - parsedAskSize < -state.quoteRequest.maxPosition
      ) {
        return {
          action: null,
          error: `Quote could breach the public hard position limit of ±${String(state.quoteRequest.maxPosition)}.`
        } as const;
      }
    }
    const action: QuantTradingCandidateAction = {
      type: "QUOTE",
      quote: {
        bidPrice: parsedBidPrice,
        bidSize: parsedBidSize,
        askPrice: parsedAskPrice,
        askSize: parsedAskSize
      }
    };
    return { action, error: null } as const;
  }, [askPrice, askSize, bidPrice, bidSize, state]);

  if (state === null) {
    return (
      <main className="quant-workspace quant-workspace--centered" data-testid="quant-trading-workspace">
        <section className="quant-empty">
          <strong>{loading ? "Loading market state…" : "Market state is not loaded."}</strong>
          <span>The deterministic server remains authoritative.</span>
          <button type="button" onClick={() => void onRefresh()} disabled={loading}>Refresh state</button>
        </section>
      </main>
    );
  }

  const terminal = state.status !== "ACTIVE";
  const quoteRequest = state.quoteRequest;
  const controlsDisabled = disabled || actionPending || terminal || quoteRequest === undefined;

  const submitQuote = async (event: React.SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (controlsDisabled) return;
    setLocalError(null);
    if (validation.action === null) {
      setLocalError(validation.error ?? "Enter a complete quote.");
      return;
    }
    try {
      await onSubmit(validation.action);
      setBidPrice("");
      setBidSize("");
      setAskPrice("");
      setAskSize("");
    } catch {
      // The hook refreshes stale/uncertain authority and exposes bounded product feedback.
    }
  };

  const pass = async (): Promise<void> => {
    if (controlsDisabled) return;
    setLocalError(null);
    try {
      await onSubmit({ type: "PASS" });
    } catch {
      // Candidate intent is never automatically resubmitted.
    }
  };

  return (
    <main className="quant-workspace" data-testid="quant-trading-workspace">
      <div className="quant-grid">
        <section className="quant-primary">
          <div className="quant-kicker-row">
            <span className="quant-kicker">Market making</span>
            <span className="quant-progress">Round {state.currentRound} / {state.plannedRounds}</span>
          </div>
          <div className="quant-market-head">
            <div>
              <h1>{state.scenario.id}</h1>
              <p>Version {state.scenario.version}</p>
            </div>
            <div className="quant-fair-value">
              <span>Public fair value</span>
              <strong>{displayNumber(state.fairValue)}</strong>
            </div>
          </div>

          {state.marketUpdates.length > 0 && (
            <div className="quant-update-strip" aria-label="Current public market updates">
              {state.marketUpdates.map((update) => (
                <div key={`${String(update.round)}:${update.label}`}>
                  <strong>{update.label}</strong>
                  <span>{displayNumber(update.previousFairValue)} → {displayNumber(update.fairValue)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="quant-stat-grid" aria-label="Public portfolio">
            <div><span>Position</span><strong>{state.portfolio.position > 0 ? "+" : ""}{state.portfolio.position}</strong></div>
            <div><span>Cash</span><strong>{displayNumber(state.portfolio.cash)}</strong></div>
            <div><span>Total P&amp;L</span><strong>{displayNumber(state.portfolio.totalPnL)}</strong></div>
            <div><span>Max drawdown</span><strong>{displayNumber(state.portfolio.maxDrawdown)}</strong></div>
          </div>

          {terminal ? (
            <section className="quant-terminal" data-testid="quant-trading-complete">
              <div>
                <span>{state.status === "RISK_STOPPED" ? "Risk stop" : "Scenario complete"}</span>
                <h2>{state.completion?.objectiveScore ?? 0}<small>/100</small></h2>
              </div>
              <dl>
                <div><dt>Rounds</dt><dd>{state.completion?.roundsCompleted ?? state.currentRound}/{state.plannedRounds}</dd></div>
                <div><dt>Trades</dt><dd>{state.completion?.tradeCount ?? state.portfolio.tradeCount}</dd></div>
                <div><dt>Fill volume</dt><dd>{state.completion?.fillVolume ?? 0}</dd></div>
                <div><dt>Avg. spread</dt><dd>{displayNumber(state.completion?.averageSpread ?? 0)}</dd></div>
              </dl>
              <button type="button" onClick={onReview}>Open review</button>
            </section>
          ) : (
            <form className="quant-quote-form" onSubmit={(event) => void submitQuote(event)}>
              <div className="quant-quote-heading">
                <div>
                  <h2>Submit quote</h2>
                  <p>
                    Tick {quoteRequest === undefined ? "—" : displayNumber(quoteRequest.tickSize)}
                    {" · "}max size {quoteRequest?.maxQuoteSize ?? "—"}
                    {" · "}position limit ±{quoteRequest?.maxPosition ?? "—"}
                  </p>
                </div>
                {quoteRequest?.hardPositionLimit && <span className="quant-risk-pill">Hard limit</span>}
              </div>
              <div className="quant-quote-inputs">
                <label>
                  <span>Bid</span>
                  <input
                    value={bidPrice}
                    onChange={(event) => setBidPrice(event.target.value)}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="Bid price"
                    disabled={controlsDisabled}
                    data-testid="quant-bid-price"
                  />
                </label>
                <label>
                  <span>Size</span>
                  <input
                    value={bidSize}
                    onChange={(event) => setBidSize(event.target.value)}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="Bid size"
                    disabled={controlsDisabled}
                    data-testid="quant-bid-size"
                  />
                </label>
                <label>
                  <span>Ask</span>
                  <input
                    value={askPrice}
                    onChange={(event) => setAskPrice(event.target.value)}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="Ask price"
                    disabled={controlsDisabled}
                    data-testid="quant-ask-price"
                  />
                </label>
                <label>
                  <span>Size</span>
                  <input
                    value={askSize}
                    onChange={(event) => setAskSize(event.target.value)}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="Ask size"
                    disabled={controlsDisabled}
                    data-testid="quant-ask-size"
                  />
                </label>
              </div>
              {(localError ?? validation.error) !== null && (
                <p className="quant-field-error" role="alert">{localError ?? validation.error}</p>
              )}
              <div className="quant-action-row">
                <button
                  type="submit"
                  className="quant-primary-action"
                  disabled={controlsDisabled || validation.action === null}
                  data-testid="quant-submit-quote"
                >
                  {actionPending ? "Submitting…" : "Submit quote"}
                </button>
                <button
                  type="button"
                  className="quant-secondary-action"
                  disabled={controlsDisabled}
                  onClick={() => void pass()}
                  data-testid="quant-pass"
                >
                  Pass
                </button>
              </div>
            </form>
          )}

          {state.lastRound !== undefined && (
            <section className="quant-round-result">
              <div className="quant-section-title">
                <h2>Round {state.lastRound.round} result</h2>
                {state.lastRound.riskBreached && <span className="quant-risk-pill">Risk warning</span>}
              </div>
              <div className="quant-stat-grid quant-stat-grid--compact">
                <div><span>Fair value</span><strong>{displayNumber(state.lastRound.fairValue)}</strong></div>
                <div><span>Position</span><strong>{state.lastRound.portfolio.position}</strong></div>
                <div><span>P&amp;L</span><strong>{displayNumber(state.lastRound.portfolio.totalPnL)}</strong></div>
                <div><span>Fills</span><strong>{state.lastRound.fills.length}</strong></div>
              </div>
              {state.lastRound.fills.length > 0 && (
                <div className="quant-fill-list">
                  {state.lastRound.fills.map((fill, index) => (
                    <span key={`${fill.side}:${String(fill.price)}:${String(fill.size)}:${String(index)}`}>
                      {fill.side} {fill.size} @ {displayNumber(fill.price)}
                    </span>
                  ))}
                </div>
              )}
            </section>
          )}
        </section>

        <aside className="quant-side">
          <div className="quant-side-section">
            <div className="quant-section-title">
              <h2>Public state</h2>
              <button type="button" onClick={() => void onRefresh()} disabled={loading || actionPending}>Refresh</button>
            </div>
            <dl className="quant-detail-list">
              <div><dt>Status</dt><dd>{state.status.replace("_", " ")}</dd></div>
              <div><dt>Realized P&amp;L</dt><dd>{displayNumber(state.portfolio.realizedPnL)}</dd></div>
              <div><dt>Unrealized P&amp;L</dt><dd>{displayNumber(state.portfolio.unrealizedPnL)}</dd></div>
              <div><dt>Portfolio value</dt><dd>{displayNumber(state.portfolio.portfolioValue)}</dd></div>
              <div><dt>Trades</dt><dd>{state.portfolio.tradeCount}</dd></div>
            </dl>
          </div>
          <div className="quant-side-note">
            Actions are bound to the currently loaded round. If the server reports stale progress, the workspace refreshes and does not resubmit.
          </div>
        </aside>
      </div>
    </main>
  );
};
