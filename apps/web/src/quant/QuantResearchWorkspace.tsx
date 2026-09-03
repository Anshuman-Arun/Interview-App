import React, { useMemo, useState } from "react";
import type {
  QuantResearchCandidateAction,
  QuantResearchPublicState
} from "../../../../packages/domain/src/index.js";

export interface QuantResearchWorkspaceProps {
  readonly state: QuantResearchPublicState | null;
  readonly loading: boolean;
  readonly actionPending: boolean;
  readonly disabled: boolean;
  readonly onRefresh: () => Promise<unknown>;
  readonly onSubmit: (action: QuantResearchCandidateAction) => Promise<QuantResearchPublicState>;
  readonly onReview: () => void;
}

type ResearchActionWithoutId =
  QuantResearchCandidateAction extends infer Action
    ? Action extends { readonly actionId: string }
      ? Omit<Action, "actionId">
      : never
    : never;

function displayFamily(value: QuantResearchPublicState["family"]): string {
  return value.split("_").map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(" ");
}

function displayValue(value: number | string | boolean | readonly number[] | readonly string[]): React.ReactNode {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="quant-muted">None yet</span>;
    return <span className="quant-data-array">{value.join(", ")}</span>;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return value;
}

function newActionId(): string {
  return `qra_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 28)}`;
}

function finite(raw: string): number | null {
  if (raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function integer(raw: string): number | null {
  const value = finite(raw);
  return value !== null && Number.isSafeInteger(value) ? value : null;
}

interface ActionEditorProps {
  readonly state: QuantResearchPublicState;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onSubmit: (action: QuantResearchCandidateAction) => Promise<QuantResearchPublicState>;
}

const ResearchActionEditor: React.FC<ActionEditorProps> = ({ state, disabled, pending, onSubmit }) => {
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const observationCount = useMemo(() => {
    const datum = state.visibleData.find((item) => item.key === "observations");
    return Array.isArray(datum?.value) ? datum.value.length : 0;
  }, [state.visibleData]);
  const maxSamples = useMemo(() => {
    const datum = state.visibleData.find((item) => item.key === "maxSamples");
    return typeof datum?.value === "number" ? datum.value : null;
  }, [state.visibleData]);

  const submit = async (action: ResearchActionWithoutId): Promise<void> => {
    if (disabled || pending) return;
    setLocalError(null);
    try {
      await onSubmit({ ...action, actionId: newActionId() } as QuantResearchCandidateAction);
      setPrimary("");
      setSecondary("");
    } catch {
      // The authoritative hook owns bounded server/stale-state feedback.
    }
  };

  const numericForm = (
    label: string,
    min: number,
    max: number,
    kind: "SUBMIT_PROBABILITY" | "SUBMIT_NUMERIC_ESTIMATE"
  ): React.ReactNode => (
    <form
      className="quant-research-action"
      onSubmit={(event) => {
        event.preventDefault();
        const value = finite(primary);
        if (value === null || value < min || value > max) {
          setLocalError(`${label} must be a finite number from ${String(min)} to ${String(max)}.`);
          return;
        }
        void submit({ kind, value });
      }}
    >
      <label>
        <span>{label}</span>
        <input
          value={primary}
          onChange={(event) => setPrimary(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          disabled={disabled || pending}
        />
      </label>
      {localError !== null && <p className="quant-field-error" role="alert">{localError}</p>}
      <button type="submit" className="quant-primary-action" disabled={disabled || pending}>
        {pending ? "Submitting…" : "Submit"}
      </button>
    </form>
  );

  if (state.family === "BAYESIAN_UPDATING" && state.stage !== "COMPLETE") {
    return numericForm("Probability", 0, 1, "SUBMIT_PROBABILITY");
  }

  if (state.family === "SAMPLING_ESTIMATION") {
    if (state.stage === "OUTLIER_PERTURBATION") {
      return numericForm("Revised center estimate", -1_000_000, 1_000_000, "SUBMIT_NUMERIC_ESTIMATE");
    }
    if (state.stage === "SAMPLING") {
      const remaining = maxSamples === null ? null : Math.max(0, maxSamples - observationCount);
      return (
        <div className="quant-research-action-stack">
          <form
            className="quant-research-action quant-research-action--inline"
            onSubmit={(event) => {
              event.preventDefault();
              const count = integer(primary);
              if (count === null || count < 1 || count > 32 || (remaining !== null && count > remaining)) {
                setLocalError(
                  remaining === null
                    ? "Observation count must be a whole number from 1 to 32."
                    : `Request between 1 and ${String(Math.min(32, remaining))} remaining observations.`
                );
                return;
              }
              void submit({ kind: "REQUEST_OBSERVATION", count });
            }}
          >
            <label>
              <span>Request observations{remaining === null ? "" : ` · ${String(remaining)} remaining`}</span>
              <input
                value={primary}
                onChange={(event) => setPrimary(event.target.value)}
                inputMode="numeric"
                autoComplete="off"
                disabled={disabled || pending || remaining === 0}
              />
            </label>
            <button type="submit" className="quant-secondary-action" disabled={disabled || pending || remaining === 0}>
              Request
            </button>
          </form>
          <form
            className="quant-research-action quant-research-action--inline"
            onSubmit={(event) => {
              event.preventDefault();
              const value = finite(secondary);
              if (value === null) {
                setLocalError("Center estimate must be finite.");
                return;
              }
              void submit({ kind: "SUBMIT_NUMERIC_ESTIMATE", value });
            }}
          >
            <label>
              <span>Commit center estimate</span>
              <input
                value={secondary}
                onChange={(event) => setSecondary(event.target.value)}
                inputMode="decimal"
                autoComplete="off"
                disabled={disabled || pending || observationCount < 2}
              />
            </label>
            <button type="submit" className="quant-primary-action" disabled={disabled || pending || observationCount < 2}>
              Submit estimate
            </button>
          </form>
          {observationCount < 2 && <p className="quant-helper">Reveal at least two observations before committing an estimate.</p>}
          {localError !== null && <p className="quant-field-error" role="alert">{localError}</p>}
        </div>
      );
    }
  }

  if (
    state.family === "EXPERIMENTAL_ALLOCATION"
    && (state.stage === "INITIAL_ALLOCATION" || state.stage === "PERTURBED_ALLOCATION")
  ) {
    return (
      <form
        className="quant-research-action"
        onSubmit={(event) => {
          event.preventDefault();
          const a = integer(primary);
          const b = integer(secondary);
          if (a === null || b === null || a < 1 || b < 1 || a > 100 || b > 100) {
            setLocalError("A and B allocations must be whole numbers from 1 to 100.");
            return;
          }
          void submit({ kind: "ALLOCATE_SAMPLE", a, b });
        }}
      >
        <div className="quant-paired-inputs">
          <label><span>Samples A</span><input value={primary} onChange={(event) => setPrimary(event.target.value)} inputMode="numeric" disabled={disabled || pending} /></label>
          <label><span>Samples B</span><input value={secondary} onChange={(event) => setSecondary(event.target.value)} inputMode="numeric" disabled={disabled || pending} /></label>
        </div>
        {localError !== null && <p className="quant-field-error" role="alert">{localError}</p>}
        <button type="submit" className="quant-primary-action" disabled={disabled || pending}>
          {pending ? "Submitting…" : "Submit allocation"}
        </button>
      </form>
    );
  }

  if (state.family === "EXPERIMENTAL_ALLOCATION" && state.stage === "EXPERIMENT_DECISION") {
    return (
      <div className="quant-choice-grid" role="group" aria-label="Choose experiment with larger latent mean">
        <button type="button" disabled={disabled || pending} onClick={() => void submit({ kind: "CHOOSE_OPTION", option: "A" })}>Experiment A</button>
        <button type="button" disabled={disabled || pending} onClick={() => void submit({ kind: "CHOOSE_OPTION", option: "B" })}>Experiment B</button>
      </div>
    );
  }

  if (
    state.family === "MODEL_COMPARISON"
    && (state.stage === "INITIAL_MODEL_CHOICE" || state.stage === "OUTLIER_MODEL_CHOICE")
  ) {
    return (
      <div className="quant-choice-grid" role="group" aria-label="Choose generating family">
        <button type="button" disabled={disabled || pending} onClick={() => void submit({ kind: "CHOOSE_OPTION", option: "CONSTANT" })}>Constant mean</button>
        <button type="button" disabled={disabled || pending} onClick={() => void submit({ kind: "CHOOSE_OPTION", option: "LINEAR" })}>Linear trend</button>
      </div>
    );
  }

  if (
    state.family === "CONSTRAINED_OPTIMIZATION"
    && (state.stage === "BASE_OPTIMIZATION" || state.stage === "PERTURBED_OPTIMIZATION")
  ) {
    return (
      <form
        className="quant-research-action"
        onSubmit={(event) => {
          event.preventDefault();
          const x = integer(primary);
          const y = integer(secondary);
          if (x === null || y === null || x < 0 || y < 0) {
            setLocalError("x and y must be nonnegative whole numbers.");
            return;
          }
          void submit({ kind: "SUBMIT_PARAMETERS", values: [x, y] });
        }}
      >
        <div className="quant-paired-inputs">
          <label><span>x</span><input value={primary} onChange={(event) => setPrimary(event.target.value)} inputMode="numeric" disabled={disabled || pending} /></label>
          <label><span>y</span><input value={secondary} onChange={(event) => setSecondary(event.target.value)} inputMode="numeric" disabled={disabled || pending} /></label>
        </div>
        {localError !== null && <p className="quant-field-error" role="alert">{localError}</p>}
        <button type="submit" className="quant-primary-action" disabled={disabled || pending}>
          {pending ? "Submitting…" : "Submit parameters"}
        </button>
      </form>
    );
  }

  return (
    <div className="quant-side-note">
      No candidate action is available for this public stage.
    </div>
  );
};

export const QuantResearchWorkspace: React.FC<QuantResearchWorkspaceProps> = ({
  state,
  loading,
  actionPending,
  disabled,
  onRefresh,
  onSubmit,
  onReview
}) => {
  if (state === null) {
    return (
      <main className="quant-workspace quant-workspace--centered" data-testid="quant-research-workspace">
        <section className="quant-empty">
          <strong>{loading ? "Loading research state…" : "Research state is not loaded."}</strong>
          <span>The deterministic server remains authoritative.</span>
          <button type="button" onClick={() => void onRefresh()} disabled={loading}>Refresh state</button>
        </section>
      </main>
    );
  }

  const complete = state.status === "COMPLETE";
  const metrics = state.completion === undefined ? [] : Object.entries(state.completion.metrics);

  return (
    <main className="quant-workspace" data-testid="quant-research-workspace">
      <div className="quant-grid">
        <section className="quant-primary">
          <div className="quant-kicker-row">
            <span className="quant-kicker">{displayFamily(state.family)}</span>
            <span className="quant-progress">Action {state.acceptedActionCount} / {state.actionLimit}</span>
          </div>
          <div className="quant-research-head">
            <div>
              <h1>{state.stage.replaceAll("_", " ")}</h1>
              <p>{state.prompt}</p>
            </div>
          </div>

          <section className="quant-public-data">
            <div className="quant-section-title"><h2>Public data</h2></div>
            <dl>
              {state.visibleData.map((datum) => (
                <div key={datum.key}>
                  <dt>{datum.label}</dt>
                  <dd>{displayValue(datum.value)}</dd>
                </div>
              ))}
            </dl>
          </section>

          {complete ? (
            <section className="quant-terminal" data-testid="quant-research-complete">
              <div>
                <span>Scenario complete</span>
                <h2>{state.completion?.overallScore ?? 0}<small>/100</small></h2>
              </div>
              <div className="quant-metric-list">
                {metrics.map(([name, score]) => (
                  <div key={name}><span>{name.replaceAll("_", " ")}</span><strong>{score}</strong></div>
                ))}
              </div>
              {state.completion?.evidence.map((item, index) => (
                <div className="quant-evidence" key={`${item.category}:${item.stage}:${String(index)}`}>
                  <div><strong>{item.category.replaceAll("_", " ")}</strong><span>{item.score}/100</span></div>
                  <p>{item.summary}</p>
                </div>
              ))}
              <button type="button" onClick={onReview}>Open review</button>
            </section>
          ) : (
            <section className="quant-action-panel">
              <div className="quant-section-title">
                <div>
                  <h2>Candidate action</h2>
                  <p>Structured input only. Voice is not admitted as an authoritative action.</p>
                </div>
              </div>
              <ResearchActionEditor
                key={`${state.family}:${state.stage}:${String(state.acceptedActionCount)}`}
                state={state}
                disabled={disabled}
                pending={actionPending}
                onSubmit={onSubmit}
              />
            </section>
          )}
        </section>

        <aside className="quant-side">
          <div className="quant-side-section">
            <div className="quant-section-title">
              <h2>Progress</h2>
              <button type="button" onClick={() => void onRefresh()} disabled={loading || actionPending}>Refresh</button>
            </div>
            <dl className="quant-detail-list">
              <div><dt>Status</dt><dd>{state.status.replace("_", " ")}</dd></div>
              <div><dt>Stage</dt><dd>{state.stage.replaceAll("_", " ")}</dd></div>
              <div><dt>Admitted actions</dt><dd>{state.acceptedActionCount}</dd></div>
              <div><dt>Scenario version</dt><dd>{state.version}</dd></div>
            </dl>
          </div>
          <div className="quant-side-note">
            The workspace renders only the server's public scenario projection. Hidden generation parameters and grading targets are never reconstructed here.
          </div>
        </aside>
      </div>
    </main>
  );
};
