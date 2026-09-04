import { useEffect, useMemo, useState, type SyntheticEvent } from "react";
import {
  InterviewSessionConfigurationSchema,
  type InterviewCatalogEntry,
  type InterviewMode,
  type InterviewSessionConfiguration,
  type ProviderLaunchAvailabilityReason,
  type ProviderLaunchOption,
  type SessionId
} from "../../../../packages/domain/src/index.js";
import {
  getDesktopRuntimeBridge,
  readDesktopRuntimeStatus,
  type DesktopRuntimeStatus
} from "../desktop-runtime.js";
import "./NewInterviewPage.css";

const MODE_LABELS: Readonly<Record<InterviewMode, string>> = {
  OXFORD_MATHEMATICS: "Oxford Mathematics",
  QUANT_TRADING: "Quant Trading",
  QUANT_RESEARCH: "Quant Research"
};

const INTERVENTION_LABELS = {
  MINIMAL: "Minimal",
  BALANCED: "Standard",
  STRICT: "Strict"
} as const;

function targetKey(entry: InterviewCatalogEntry): string {
  return `${entry.mode}:${entry.id}@${entry.version}`;
}

function providerKey(option: ProviderLaunchOption): string {
  return `${option.providerId}:${option.modelId}`;
}

function providerReason(reason: ProviderLaunchAvailabilityReason | undefined): string {
  switch (reason) {
    case "CREDENTIALS_REQUIRED":
      return "Authentication is not configured";
    case "DISABLED":
      return "Disabled by runtime configuration";
    case "RUNTIME_CONFIGURATION_UNAVAILABLE":
      return "Runtime configuration is unavailable";
    case "RUNTIME_DEPENDENCY_UNAVAILABLE":
      return "Local runtime dependency is unavailable";
    case "POLICY_UNAVAILABLE":
      return "Safety policy could not be verified";
    case "POLICY_DENIED":
      return "Denied by the current safety policy";
    case "CAPABILITY_UNAVAILABLE":
      return "Required reasoning capability is unavailable";
    case "PROVIDER_UNAVAILABLE":
      return "Provider is not currently executable";
    case "UNKNOWN":
    default:
      return "Readiness could not be verified";
  }
}

export function NewInterviewPage({
  catalog,
  catalogLoading,
  catalogError,
  providerOptions,
  providerOptionsLoading,
  providerOptionsError,
  activeSessionId,
  startPending,
  onRefreshCatalog,
  onRefreshProviderOptions,
  onStart,
  onResumeActive
}: {
  readonly catalog: readonly InterviewCatalogEntry[];
  readonly catalogLoading: boolean;
  readonly catalogError: string | null;
  readonly providerOptions: readonly ProviderLaunchOption[];
  readonly providerOptionsLoading: boolean;
  readonly providerOptionsError: string | null;
  readonly activeSessionId: SessionId | null;
  readonly startPending: boolean;
  readonly onRefreshCatalog: () => Promise<readonly InterviewCatalogEntry[]>;
  readonly onRefreshProviderOptions: () => Promise<readonly ProviderLaunchOption[]>;
  readonly onStart: (configuration: InterviewSessionConfiguration) => Promise<void>;
  readonly onResumeActive: (() => void) | null;
}) {
  const [mode, setMode] = useState<InterviewMode | "">("");
  const [selectedTargetKey, setSelectedTargetKey] = useState("");
  const [selectedProviderKey, setSelectedProviderKey] = useState("");
  const [durationText, setDurationText] = useState("");
  const [interventionPolicy, setInterventionPolicy] =
    useState<"MINIMAL" | "BALANCED" | "STRICT">("BALANCED");
  const [formError, setFormError] = useState<string | null>(null);
  const desktopRuntime = useMemo(() => getDesktopRuntimeBridge(), []);
  const [localRuntimeStatus, setLocalRuntimeStatus] =
    useState<DesktopRuntimeStatus | undefined>();
  const [localRuntimeStatusError, setLocalRuntimeStatusError] = useState(false);

  useEffect(() => {
    if (desktopRuntime === undefined) return;
    let active = true;
    void readDesktopRuntimeStatus(desktopRuntime)
      .then((status) => {
        if (active) {
          setLocalRuntimeStatus(status);
          setLocalRuntimeStatusError(false);
        }
      })
      .catch(() => {
        if (active) {
          setLocalRuntimeStatus(undefined);
          setLocalRuntimeStatusError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [desktopRuntime]);

  useEffect(() => {
    void onRefreshCatalog().catch(() => undefined);
    void onRefreshProviderOptions().catch(() => undefined);
  }, [onRefreshCatalog, onRefreshProviderOptions]);

  const modes = useMemo(() => {
    const output: InterviewMode[] = [];
    for (const entry of catalog) {
      if (!output.includes(entry.mode)) output.push(entry.mode);
    }
    return output;
  }, [catalog]);

  useEffect(() => {
    if (mode !== "" && modes.includes(mode)) return;
    setMode(modes[0] ?? "");
  }, [mode, modes]);

  const targets = useMemo(
    () => mode === "" ? [] : catalog.filter((entry) => entry.mode === mode),
    [catalog, mode]
  );

  useEffect(() => {
    if (targets.some((entry) => targetKey(entry) === selectedTargetKey)) return;
    setSelectedTargetKey(targets[0] === undefined ? "" : targetKey(targets[0]));
  }, [selectedTargetKey, targets]);

  const availableProviders = useMemo(
    () => providerOptions.filter((option) => option.availability === "AVAILABLE"),
    [providerOptions]
  );

  useEffect(() => {
    if (
      availableProviders.some((option) => providerKey(option) === selectedProviderKey)
    ) return;
    setSelectedProviderKey(
      availableProviders[0] === undefined ? "" : providerKey(availableProviders[0])
    );
  }, [availableProviders, selectedProviderKey]);

  const selectedTarget =
    targets.find((entry) => targetKey(entry) === selectedTargetKey) ?? null;
  const selectedProvider =
    providerOptions.find((option) => providerKey(option) === selectedProviderKey) ?? null;

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    if (activeSessionId !== null) {
      setFormError("An interview is already active. Resume it before starting another.");
      return;
    }
    if (selectedTarget === null || selectedProvider?.availability !== "AVAILABLE") {
      setFormError("Choose a currently available interview target and provider.");
      return;
    }

    let durationMinutes: number | undefined;
    if (durationText.trim().length > 0) {
      durationMinutes = Number(durationText);
      if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
        setFormError("Duration must be a whole number from 5 to 480 minutes.");
        return;
      }
    }

    const common = {
      configurationVersion: 1 as const,
      interventionPolicy,
      providerSelection: {
        providerId: selectedProvider.providerId,
        modelId: selectedProvider.modelId
      },
      ...(durationMinutes === undefined ? {} : { durationMinutes })
    };
    const candidate =
      selectedTarget.mode === "OXFORD_MATHEMATICS"
        ? {
            ...common,
            mode: "OXFORD_MATHEMATICS" as const,
            problem: {
              id: selectedTarget.id,
              version: selectedTarget.version
            }
          }
        : {
            ...common,
            mode: selectedTarget.mode,
            scenario: {
              id: selectedTarget.id,
              version: selectedTarget.version
            }
          };
    const parsed = InterviewSessionConfigurationSchema.safeParse(candidate);
    if (!parsed.success) {
      setFormError("This configuration is no longer valid. Refresh the available options.");
      return;
    }

    try {
      await onStart(parsed.data);
    } catch {
      // The authoritative hook exposes the bounded server error in the page notice.
    }
  };

  const metadataUnavailable =
    catalogError !== null
    || providerOptionsError !== null
    || modes.length === 0
    || availableProviders.length === 0;

  return (
    <div className="new-interview" data-testid="new-interview-page">
      {activeSessionId !== null && (
        <section className="new-interview__active" aria-live="polite">
          <div>
            <span>ACTIVE SESSION</span>
            <strong>Finish or resume the current interview first.</strong>
            <p>Starting a second authoritative session is disabled.</p>
          </div>
          {onResumeActive !== null && (
            <button type="button" onClick={onResumeActive}>
              Resume interview
            </button>
          )}
        </section>
      )}

      <form className="new-interview__layout" onSubmit={(event) => void submit(event)}>
        <div className="new-interview__config">
          <section className="new-interview__section">
            <div className="new-interview__section-heading">
              <span>01</span>
              <div>
                <h2>Interview</h2>
                <p>Choose the room and the server-published problem or scenario.</p>
              </div>
            </div>

            {catalogLoading ? (
              <p className="new-interview__status">Loading interview catalog…</p>
            ) : catalogError !== null ? (
              <div className="new-interview__error" role="alert">
                <p>{catalogError}</p>
                <button type="button" onClick={() => void onRefreshCatalog().catch(() => undefined)}>
                  Retry catalog
                </button>
              </div>
            ) : modes.length === 0 ? (
              <p className="new-interview__status">No interview targets are currently available.</p>
            ) : (
              <>
                <select
                  className="new-interview__test-select"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as InterviewMode)}
                  data-testid="interview-mode-select"
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  {modes.map((entryMode) => (
                    <option key={entryMode} value={entryMode}>{MODE_LABELS[entryMode]}</option>
                  ))}
                </select>

                <div className="new-interview__mode-choice" role="radiogroup" aria-label="Interview mode">
                  {modes.map((entryMode) => (
                    <button
                      key={entryMode}
                      type="button"
                      role="radio"
                      aria-checked={mode === entryMode}
                      className={
                        mode === entryMode
                          ? "new-interview__choice-card new-interview__choice-card--selected"
                          : "new-interview__choice-card"
                      }
                      onClick={() => setMode(entryMode)}
                    >
                      <span>
                        {entryMode === "OXFORD_MATHEMATICS"
                          ? "Socratic + board"
                          : entryMode === "QUANT_TRADING"
                            ? "Market making"
                            : "Research"}
                      </span>
                      <strong>{MODE_LABELS[entryMode]}</strong>
                    </button>
                  ))}
                </div>

                <div className="new-interview__basics">
                  <label className="new-interview__field">
                    <span>{mode === "OXFORD_MATHEMATICS" ? "Problem" : "Scenario"}</span>
                    <div className="new-interview__select-shell">
                      <select
                        value={selectedTargetKey}
                        onChange={(event) => setSelectedTargetKey(event.target.value)}
                        data-testid="interview-target-select"
                      >
                        {targets.map((entry) => (
                          <option key={targetKey(entry)} value={targetKey(entry)}>
                            {entry.title}
                          </option>
                        ))}
                      </select>
                      <i aria-hidden="true">⌄</i>
                    </div>
                  </label>

                  <label className="new-interview__field new-interview__field--duration">
                    <span>Duration <small>optional</small></span>
                    <div className="new-interview__duration">
                      <input
                        type="number"
                        min={5}
                        max={480}
                        step={1}
                        value={durationText}
                        onChange={(event) => setDurationText(event.target.value)}
                        placeholder="50"
                        data-testid="duration-input"
                      />
                      <span>min</span>
                    </div>
                  </label>
                </div>
              </>
            )}
          </section>

          <section className="new-interview__section">
            <div className="new-interview__section-heading">
              <span>02</span>
              <div>
                <h2>Intervention</h2>
                <p>Control how quickly the interviewer steps in when the reasoning stalls.</p>
              </div>
            </div>

            <select
              className="new-interview__test-select"
              value={interventionPolicy}
              onChange={(event) =>
                setInterventionPolicy(
                  event.target.value as "MINIMAL" | "BALANCED" | "STRICT"
                )
              }
              data-testid="intervention-select"
              tabIndex={-1}
              aria-hidden="true"
            >
              {(Object.keys(INTERVENTION_LABELS) as Array<keyof typeof INTERVENTION_LABELS>)
                .map((policy) => (
                  <option key={policy} value={policy}>{INTERVENTION_LABELS[policy]}</option>
                ))}
            </select>

            <div className="new-interview__segments" role="radiogroup" aria-label="Intervention policy">
              {(Object.keys(INTERVENTION_LABELS) as Array<keyof typeof INTERVENTION_LABELS>)
                .map((policy) => (
                  <button
                    key={policy}
                    type="button"
                    role="radio"
                    aria-checked={interventionPolicy === policy}
                    onClick={() => setInterventionPolicy(policy)}
                  >
                    {INTERVENTION_LABELS[policy]}
                  </button>
                ))}
            </div>
          </section>

          <section className="new-interview__section">
            <div className="new-interview__section-heading">
              <span>03</span>
              <div>
                <h2>Reasoning provider</h2>
                <p>Only launch-ready providers are selectable; server policy remains authoritative.</p>
              </div>
            </div>

            {providerOptionsLoading ? (
              <p className="new-interview__status">Checking providers…</p>
            ) : providerOptionsError !== null ? (
              <div className="new-interview__error" role="alert">
                <p>{providerOptionsError}</p>
                <button type="button" onClick={() => void onRefreshProviderOptions().catch(() => undefined)}>
                  Retry providers
                </button>
              </div>
            ) : (
              <div className="new-interview__provider-card">
                <header>
                  <strong>Provider / model</strong>
                  <span className="new-interview__availability">
                    <i aria-hidden="true" />
                    {availableProviders.length > 0 ? "AVAILABLE" : "UNAVAILABLE"}
                  </span>
                </header>
                <div className="new-interview__provider-main">
                  <div className="new-interview__select-shell">
                    <select
                      value={selectedProviderKey}
                      onChange={(event) => setSelectedProviderKey(event.target.value)}
                      disabled={availableProviders.length === 0}
                      data-testid="provider-select"
                    >
                      {availableProviders.length === 0 && (
                        <option value="">No launch-ready provider</option>
                      )}
                      {availableProviders.map((option) => (
                        <option key={providerKey(option)} value={providerKey(option)}>
                          {option.providerDisplayName} · {option.modelDisplayName}
                        </option>
                      ))}
                    </select>
                    <i aria-hidden="true">⌄</i>
                  </div>
                  {selectedProvider !== null && (
                    <div className="new-interview__provider-meta">
                      <span>{selectedProvider.providerDisplayName}</span>
                      <b>{selectedProvider.modelDisplayName}</b>
                    </div>
                  )}
                </div>

                {providerOptions.some((option) => option.availability === "UNAVAILABLE") && (
                  <details className="new-interview__unavailable">
                    <summary>Registered but unavailable</summary>
                    <ul>
                      {providerOptions
                        .filter((option) => option.availability === "UNAVAILABLE")
                        .map((option) => (
                          <li key={providerKey(option)}>
                            <strong>{option.providerDisplayName} · {option.modelDisplayName}</strong>
                            <span>{providerReason(option.reason)}</span>
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </section>

          {desktopRuntime !== undefined && localRuntimeStatusError ? (
            <div className="new-interview__capability-note" aria-live="polite">
              <span>Local AI readiness could not be verified — typed input and drawing still work.</span>
            </div>
          ) : localRuntimeStatus !== undefined && (
            localRuntimeStatus.speech.state !== "READY"
            || localRuntimeStatus.tts.state !== "READY"
            || localRuntimeStatus.vision.state !== "READY"
          ) ? (
            <div className="new-interview__capability-note" aria-live="polite">
              {(localRuntimeStatus.speech.state !== "READY"
                || localRuntimeStatus.tts.state !== "READY") && (
                <span>Voice unavailable — typed input will be used.</span>
              )}
              {localRuntimeStatus.vision.state !== "READY" && (
                <span>Whiteboard recognition unavailable — drawing still works.</span>
              )}
            </div>
          ) : null}

          {formError !== null && (
            <p className="new-interview__form-error" role="alert">{formError}</p>
          )}
        </div>

        <aside className="new-interview__slip">
          <div className="new-interview__slip-kicker">
            <span>Configuration</span>
            <span>READY SLIP</span>
          </div>
          <h3>{mode === "" ? "Interview" : MODE_LABELS[mode]}</h3>
          <p className="new-interview__slip-sub">
            {selectedTarget?.title ?? "Choose a server-published target."}
          </p>

          <div className="new-interview__slip-list">
            <div>
              <span>Mode</span>
              <strong>{mode === "" ? "—" : MODE_LABELS[mode]}</strong>
            </div>
            <div>
              <span>{mode === "OXFORD_MATHEMATICS" ? "Problem" : "Scenario"}</span>
              <strong>{selectedTarget?.title ?? "—"}</strong>
            </div>
            <div>
              <span>Duration</span>
              <strong>{durationText.trim().length === 0 ? "Flexible" : `${durationText} min`}</strong>
            </div>
            <div>
              <span>Intervention</span>
              <strong>{INTERVENTION_LABELS[interventionPolicy]}</strong>
            </div>
            <div>
              <span>Provider</span>
              <strong>
                {selectedProvider === null
                  ? "—"
                  : `${selectedProvider.providerDisplayName} · ${selectedProvider.modelDisplayName}`}
              </strong>
            </div>
          </div>

          <button
            type="submit"
            className="new-interview__start"
            disabled={
              activeSessionId !== null
              || startPending
              || catalogLoading
              || providerOptionsLoading
              || metadataUnavailable
              || selectedTarget === null
              || selectedProvider?.availability !== "AVAILABLE"
            }
            data-testid="start-configured-session-btn"
          >
            <span>{startPending ? "Starting…" : "Start interview"}</span>
            <em aria-hidden="true">→</em>
          </button>

          <p className="new-interview__ready-note">
            <i aria-hidden="true" />
            {activeSessionId !== null
              ? "Current interview owns session authority."
              : metadataUnavailable
                ? "Resolve launch readiness before starting."
                : "Configuration is revalidated by the server."}
          </p>
        </aside>
      </form>
    </div>
  );
}
