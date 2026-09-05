import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import {
  InterviewSessionConfigurationSchema,
  type InterviewCatalogEntry,
  type InterviewMode,
  type InterviewSessionConfiguration,
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
  BALANCED: "Balanced",
  STRICT: "Strict"
} as const;

function targetKey(entry: InterviewCatalogEntry): string {
  return `${entry.mode}:${entry.id}@${entry.version}`;
}

function providerKey(option: ProviderLaunchOption): string {
  return `${option.providerId}:${option.modelId}`;
}

function providerRouteLabel(option: ProviderLaunchOption | null): string {
  switch (option?.providerKind) {
    case "LOCAL_PROCESS":
      return "LOCAL";
    case "REMOTE_API":
      return "REMOTE";
    case "MOCK":
      return "MOCK";
    case "OTHER":
      return "RUNTIME";
    case undefined:
      return "—";
  }
}

const ANTIGRAVITY_FLASH_MODEL =
  /^gemini-(3\.[78])-flash-(high|medium|low)$/u;

function antigravityFlashParts(
  option: ProviderLaunchOption | null
): { readonly version: string; readonly tier: "high" | "medium" | "low" } | null {
  if (option?.providerId !== "antigravity-cli") return null;
  const match = ANTIGRAVITY_FLASH_MODEL.exec(option.modelId);
  if (match === null) return null;
  const version = match[1];
  const tier = match[2];
  if (
    version === undefined
    || (tier !== "high" && tier !== "medium" && tier !== "low")
  ) {
    return null;
  }
  return { version, tier };
}

function providerModelFamilyKey(option: ProviderLaunchOption): string {
  const antigravity = antigravityFlashParts(option);
  return antigravity === null
    ? providerKey(option)
    : `${option.providerId}:gemini-${antigravity.version}-flash`;
}

function providerModelFamilyLabel(option: ProviderLaunchOption | null): string {
  if (option === null) return "Not selected";
  const antigravity = antigravityFlashParts(option);
  if (antigravity !== null) return `Gemini ${antigravity.version} Flash`;
  return option.modelDisplayName;
}

function providerReasoningTier(option: ProviderLaunchOption | null): string {
  const antigravity = antigravityFlashParts(option);
  if (antigravity === null) return "default";
  return antigravity.tier;
}

function reasoningTierLabel(tier: string): string {
  return tier.length === 0
    ? "Default"
    : `${tier[0]?.toUpperCase() ?? ""}${tier.slice(1)}`;
}

function providerContextTokens(option: ProviderLaunchOption | null): string {
  if (option === null) return "—";
  if (
    antigravityFlashParts(option) !== null
    || option.modelId === "gemini-2.5-flash"
  ) {
    return "1,048,576";
  }
  return "Unknown";
}

function providerOutputTokens(option: ProviderLaunchOption | null): string {
  if (option === null) return "—";
  if (
    antigravityFlashParts(option) !== null
    || option.modelId === "gemini-2.5-flash"
  ) {
    return "65,536";
  }
  return "Unknown";
}

function providerUsageLabel(option: ProviderLaunchOption | null): string {
  if (option?.providerId === "antigravity-cli") {
    return "Account quota · credit fallback off";
  }
  if (option?.providerId === "gemini-api") return "Gemini API metered";
  if (option?.providerKind === "MOCK") return "No remote tokens";
  return "Not reported";
}


interface EditorialSelectOption {
  readonly value: string;
  readonly label: string;
  readonly meta?: string;
  readonly disabled?: boolean;
}

function EditorialSelect({
  value,
  options,
  placeholder,
  disabled,
  testId,
  model = false,
  onChange
}: {
  readonly value: string;
  readonly options: readonly EditorialSelectOption[];
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly testId: string;
  readonly model?: boolean;
  readonly onChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const details = detailsRef.current;
      const target = event.target;
      if (
        details === null
        || !details.open
        || !(target instanceof Node)
        || details.contains(target)
      ) {
        return;
      }
      details.removeAttribute("open");
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const details = detailsRef.current;
      if (details?.open !== true) return;
      details.removeAttribute("open");
      details.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <>
      <select
        className="new-interview__test-select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
        tabIndex={-1}
        aria-hidden="true"
      >
        {options.length === 0 && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <details
        ref={detailsRef}
        className={
          model
            ? "new-interview__custom-select new-interview__custom-select--model"
            : "new-interview__custom-select"
        }
      >
        <summary
          aria-disabled={disabled}
          onClick={(event) => {
            if (disabled) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (disabled && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
            }
          }}
        >
          <span>
            <strong>{selected?.label ?? placeholder}</strong>
            {selected?.meta !== undefined && <small>{selected.meta}</small>}
          </span>
          <i className="new-interview__select-caret" aria-hidden="true" />
        </summary>
        <div className="new-interview__custom-menu" role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              disabled={disabled || option.disabled === true}
              onClick={(event) => {
                onChange(option.value);
                event.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              <span>{option.label}</span>
              {option.meta !== undefined && <small>{option.meta}</small>}
            </button>
          ))}
        </div>
      </details>
    </>
  );
}

export function NewInterviewPage({
  catalog,
  catalogLoading,
  catalogError,
  providerOptions,
  providerOptionsLoading,
  providerOptionsError,
  activeSessionId,
  activeSessionCount = activeSessionId === null ? 0 : 1,
  startPending,
  sessionAuthorityChecking = false,
  sessionAuthorityUnavailable = false,
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
  readonly activeSessionCount?: number;
  readonly startPending: boolean;
  readonly sessionAuthorityChecking?: boolean;
  readonly sessionAuthorityUnavailable?: boolean;
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

  useEffect(() => {
    setFormError(null);
  }, [
    activeSessionCount,
    activeSessionId,
    catalogError,
    catalogLoading,
    durationText,
    interventionPolicy,
    mode,
    providerOptionsError,
    providerOptionsLoading,
    sessionAuthorityChecking,
    selectedProviderKey,
    selectedTargetKey
  ]);

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
  const selectableProviders = useMemo(() => {
    const realProviders = availableProviders.filter(
      (option) => option.providerKind !== "MOCK"
    );
    return realProviders.length > 0 ? realProviders : availableProviders;
  }, [availableProviders]);

  useEffect(() => {
    if (
      selectableProviders.some((option) => providerKey(option) === selectedProviderKey)
    ) return;
    const preferred = selectableProviders.find(
      (option) => option.modelId === "gemini-3.8-flash-medium"
    ) ?? selectableProviders[0];
    setSelectedProviderKey(preferred === undefined ? "" : providerKey(preferred));
  }, [selectableProviders, selectedProviderKey]);

  const modelFamilies = useMemo(() => {
    const families: Array<{
      readonly key: string;
      readonly label: string;
      readonly options: ProviderLaunchOption[];
    }> = [];
    for (const option of selectableProviders) {
      const key = providerModelFamilyKey(option);
      const existing = families.find((family) => family.key === key);
      if (existing !== undefined) {
        existing.options.push(option);
        continue;
      }
      families.push({
        key,
        label: providerModelFamilyLabel(option),
        options: [option]
      });
    }
    return families;
  }, [selectableProviders]);

  const selectedTarget =
    targets.find((entry) => targetKey(entry) === selectedTargetKey) ?? null;
  const selectedProvider =
    selectableProviders.find((option) => providerKey(option) === selectedProviderKey) ?? null;
  const selectedModelFamilyKey =
    selectedProvider === null ? "" : providerModelFamilyKey(selectedProvider);
  const selectedModelFamily =
    modelFamilies.find((family) => family.key === selectedModelFamilyKey) ?? null;
  const selectedReasoningTier = providerReasoningTier(selectedProvider);
  const durationCandidate =
    durationText.trim().length === 0 ? null : Number(durationText);
  const durationInvalid =
    durationCandidate !== null
    && (
      !Number.isInteger(durationCandidate)
      || durationCandidate < 5
      || durationCandidate > 480
    );

  const adjustDuration = (delta: number): void => {
    const parsed = Number(durationText);
    const base = Number.isInteger(parsed) && parsed >= 5 && parsed <= 480
      ? parsed
      : delta > 0
        ? 25
        : 35;
    const next = Math.min(480, Math.max(5, base + delta));
    setDurationText(String(next));
    if (formError !== null) setFormError(null);
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setFormError(null);
    if (
      startPending
      || sessionAuthorityChecking
      || catalogLoading
      || providerOptionsLoading
    ) {
      setFormError("Launch readiness is still being verified. Try again when checking finishes.");
      return;
    }
    if (sessionAuthorityUnavailable) {
      setFormError("Stored session authority could not be verified. Retry from Sessions before starting another interview.");
      return;
    }
    if (catalogError !== null || providerOptionsError !== null) {
      setFormError("Resolve launch readiness before starting the interview.");
      return;
    }
    if (activeSessionCount > 0) {
      setFormError(
        activeSessionCount > 1
          ? "Multiple interviews are active. Resolve them from Sessions before starting another."
          : activeSessionId === null
            ? "An active interview exists but is not attached yet. Resolve it from Sessions before starting another."
            : "An interview is already active. Resume it before starting another."
      );
      return;
    }
    if (selectedTarget === null || selectedProvider?.availability !== "AVAILABLE") {
      setFormError("Choose a currently available interview target and provider.");
      return;
    }

    let durationMinutes: number | undefined;
    if (durationInvalid) {
      setFormError("Duration must be a whole number from 5 to 480 minutes.");
      return;
    }
    if (durationCandidate !== null) {
      durationMinutes = durationCandidate;
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
  const sessionAuthorityBlocked =
    activeSessionId !== null || activeSessionCount > 0;
  const launchChecking =
    sessionAuthorityChecking || catalogLoading || providerOptionsLoading;
  const launchBlocked =
    metadataUnavailable
    || sessionAuthorityBlocked
    || sessionAuthorityUnavailable
    || launchChecking
    || selectedTarget === null
    || selectedProvider?.availability !== "AVAILABLE"
    || durationInvalid;

  return (
    <div className="new-interview" data-testid="new-interview-page">
      {activeSessionCount > 1 || (activeSessionCount > 0 && activeSessionId === null) ? (
        <section className="new-interview__active" role="alert">
          <div>
            <span>ACTIVE SESSION CONFLICT</span>
            <strong>
              {activeSessionCount > 1
                ? `${String(activeSessionCount)} active sessions are stored.`
                : "An active session is stored but not attached."}
            </strong>
            <p>
              {activeSessionId === null
                ? "Starting another room is disabled. Open Sessions and choose an active room to recover first."
                : "Starting another room is disabled. Resume the attached room and end or archive it before recovering another."}
            </p>
          </div>
          {onResumeActive !== null && (
            <button type="button" disabled={startPending} onClick={onResumeActive}>Resume current interview</button>
          )}
        </section>
      ) : activeSessionId !== null && (
        <section className="new-interview__active" aria-live="polite">
          <div><span>ACTIVE SESSION</span><strong>Finish or resume the current interview first.</strong><p>Starting a second authoritative session is disabled.</p></div>
          {onResumeActive !== null && <button type="button" disabled={startPending} onClick={onResumeActive}>Resume interview</button>}
        </section>
      )}
      <form className="new-interview__layout" onSubmit={(event) => void submit(event)}>
        <div className="new-interview__config">
          <section className="new-interview__section">
            <div className="new-interview__section-heading"><span>01</span><div><h2>Interview</h2></div></div>
            <select className="new-interview__test-select" value={mode} onChange={(event) => setMode(event.target.value as InterviewMode)} data-testid="interview-mode-select" tabIndex={-1} aria-hidden="true">
              {modes.map((entryMode) => <option key={entryMode} value={entryMode}>{MODE_LABELS[entryMode]}</option>)}
            </select>
            <div className="new-interview__mode-choice" aria-label="Interview mode">
              {(["OXFORD_MATHEMATICS", "QUANT_TRADING", "QUANT_RESEARCH"] as const).map((entryMode) => {
                const available = modes.includes(entryMode);
                const tag = entryMode === "OXFORD_MATHEMATICS" ? "Socratic + board" : entryMode === "QUANT_TRADING" ? "Market making" : "Research";
                return (
                  <button key={entryMode} type="button" className="new-interview__choice" aria-pressed={mode === entryMode} disabled={!available || catalogLoading || startPending} onClick={() => setMode(entryMode)}>
                    <span>{tag}</span><strong>{MODE_LABELS[entryMode]}</strong>
                  </button>
                );
              })}
            </div>
            {catalogLoading ? <p className="new-interview__status">Loading interview catalog…</p> : catalogError !== null ? (
              <div className="new-interview__error" role="alert"><p>{catalogError}</p><button type="button" onClick={() => void onRefreshCatalog().catch(() => undefined)}>Retry catalog</button></div>
            ) : modes.length === 0 ? <p className="new-interview__status">No interview targets are currently available.</p> : (
              <div className="new-interview__basics">
                <div className="new-interview__field">
                  <span>{mode === "OXFORD_MATHEMATICS" ? "Problem" : "Scenario"}</span>
                  <EditorialSelect
                    value={selectedTargetKey}
                    options={targets.map((entry) => ({
                      value: targetKey(entry),
                      label: entry.title,
                      meta: entry.mode === "OXFORD_MATHEMATICS"
                        ? `${entry.category} · ${entry.difficulty}`
                        : entry.mode === "QUANT_TRADING"
                          ? "Quant trading scenario"
                          : "Quant research scenario"
                    }))}
                    placeholder="No target available"
                    disabled={startPending || targets.length === 0}
                    testId="interview-target-select"
                    onChange={setSelectedTargetKey}
                  />
                </div>
                <label className="new-interview__field new-interview__duration-field">
                  <span>Duration</span>
                  <div className="new-interview__duration">
                    <button
                      type="button"
                      className="new-interview__duration-step"
                      aria-label="Decrease duration by 5 minutes"
                      disabled={startPending || durationText === "5"}
                      onClick={() => adjustDuration(-5)}
                    >−</button>
                    <div className="new-interview__duration-value">
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={durationText}
                        disabled={startPending}
                        onChange={(event) => {
                          const next = event.target.value;
                          if (!/^\d{0,3}(?:\.\d*)?$/u.test(next)) return;
                          setDurationText(next);
                          if (formError !== null) setFormError(null);
                        }}
                        placeholder="—"
                        aria-invalid={durationInvalid}
                        title={durationInvalid ? "Enter a whole number from 5 to 480 minutes" : undefined}
                        data-testid="duration-input"
                      />
                      <small>min</small>
                    </div>
                    <button
                      type="button"
                      className="new-interview__duration-step"
                      aria-label="Increase duration by 5 minutes"
                      disabled={startPending || durationText === "480"}
                      onClick={() => adjustDuration(5)}
                    >+</button>
                  </div>
                  <small className="new-interview__duration-help">Planning reminder only; the interview will not end automatically.</small>
                </label>
              </div>
            )}
          </section>

          <section className="new-interview__section">
            <div className="new-interview__section-heading"><span>02</span><div><h2>Model</h2></div></div>
            <div className="new-interview__provider-card">
              <header><div><strong>Reasoning</strong><small>Current runtime catalog</small></div><span className="new-interview__availability" data-ready={String(!providerOptionsLoading && selectedProvider?.availability === "AVAILABLE")}><i aria-hidden="true" />{providerOptionsLoading ? "CHECKING" : selectedProvider?.availability === "AVAILABLE" ? "READY" : "SETUP"}</span></header>
              {providerOptionsLoading ? <p className="new-interview__status">Checking providers…</p> : providerOptionsError !== null ? (
                <div className="new-interview__error" role="alert"><p>{providerOptionsError}</p><button type="button" onClick={() => void onRefreshProviderOptions().catch(() => undefined)}>Retry providers</button></div>
              ) : (
                <div className="new-interview__provider-main">
                  <select
                    className="new-interview__test-select"
                    value={selectedProviderKey}
                    disabled={startPending || selectableProviders.length === 0}
                    onChange={(event) => setSelectedProviderKey(event.target.value)}
                    data-testid="provider-select"
                    tabIndex={-1}
                    aria-hidden="true"
                  >
                    {selectableProviders.map((option) => (
                      <option key={providerKey(option)} value={providerKey(option)}>
                        {option.modelDisplayName}
                      </option>
                    ))}
                  </select>
                  <div className="new-interview__provider-controls">
                    <div className="new-interview__field">
                      <span>Model</span>
                      <EditorialSelect
                        value={selectedModelFamilyKey}
                        options={modelFamilies.map((family) => ({
                          value: family.key,
                          label: family.label,
                          ...(family.options[0] === undefined
                            ? {}
                            : {
                                meta: `${family.options[0].providerDisplayName} · ${providerRouteLabel(family.options[0])}`
                              })
                        }))}
                        placeholder="No launch-ready provider"
                        disabled={startPending || modelFamilies.length === 0}
                        testId="provider-model-select"
                        model
                        onChange={(familyKey) => {
                          const family = modelFamilies.find(
                            (candidate) => candidate.key === familyKey
                          );
                          if (family === undefined) return;
                          const preferred = family.options.find(
                            (option) => providerReasoningTier(option) === "medium"
                          ) ?? family.options[0];
                          if (preferred !== undefined) {
                            setSelectedProviderKey(providerKey(preferred));
                          }
                        }}
                      />
                    </div>
                    <div className="new-interview__field">
                      <span>Reasoning</span>
                      <EditorialSelect
                        value={selectedProviderKey}
                        options={(selectedModelFamily?.options ?? []).map((option) => ({
                          value: providerKey(option),
                          label: reasoningTierLabel(providerReasoningTier(option)),
                          meta: option.providerId === "antigravity-cli"
                            ? "Antigravity effort"
                            : "Provider default"
                        }))}
                        placeholder="Default"
                        disabled={
                          startPending
                          || selectedModelFamily === null
                          || selectedModelFamily.options.length === 0
                        }
                        testId="provider-reasoning-select"
                        onChange={setSelectedProviderKey}
                      />
                    </div>
                  </div>
                  {selectedProvider !== null && (
                    <div className="new-interview__provider-facts">
                      <span><b>PROVIDER</b>{selectedProvider.providerDisplayName}</span>
                      <span><b>MODEL</b>{providerModelFamilyLabel(selectedProvider)}</span>
                      <span><b>REASONING</b>{reasoningTierLabel(selectedReasoningTier)}</span>
                      <span><b>CONTEXT</b>{providerContextTokens(selectedProvider)} tokens</span>
                      <span><b>MAX OUTPUT</b>{providerOutputTokens(selectedProvider)} tokens</span>
                      <span><b>USAGE</b>{providerUsageLabel(selectedProvider)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="new-interview__section">
            <div className="new-interview__section-heading"><span>03</span><div><h2>Session</h2></div></div>
            <select className="new-interview__test-select" value={interventionPolicy} onChange={(event) => setInterventionPolicy(event.target.value as "MINIMAL" | "BALANCED" | "STRICT")} data-testid="intervention-select" tabIndex={-1} aria-hidden="true">
              {(Object.keys(INTERVENTION_LABELS) as Array<keyof typeof INTERVENTION_LABELS>).map((policy) => <option key={policy} value={policy}>{INTERVENTION_LABELS[policy]}</option>)}
            </select>
            <div className="new-interview__session-fields">
              <div className="new-interview__field"><span>Intervention</span><div className="new-interview__segments">
                {(Object.keys(INTERVENTION_LABELS) as Array<keyof typeof INTERVENTION_LABELS>).map((policy) => <button key={policy} type="button" aria-pressed={interventionPolicy === policy} disabled={startPending} onClick={() => setInterventionPolicy(policy)} data-testid={`intervention-${policy.toLowerCase()}`}>{INTERVENTION_LABELS[policy]}</button>)}
              </div></div>
              <div className="new-interview__input-note"><span>Input</span><strong>{mode === "OXFORD_MATHEMATICS" ? "Voice + tldraw + text" : "Structured actions"}</strong></div>
            </div>
          </section>

          {mode === "OXFORD_MATHEMATICS" && (
            desktopRuntime !== undefined && localRuntimeStatusError
              ? <div className="new-interview__capability-note" aria-live="polite"><span>Local AI readiness could not be verified — typed input and drawing still work.</span></div>
              : localRuntimeStatus !== undefined && (localRuntimeStatus.speech.state !== "READY" || localRuntimeStatus.tts.state !== "READY" || localRuntimeStatus.vision.state !== "READY")
                ? (
                    <div className="new-interview__capability-note" aria-live="polite">
                      {(localRuntimeStatus.speech.state !== "READY" || localRuntimeStatus.tts.state !== "READY") && <span>Voice unavailable — typed input will be used.</span>}
                      {localRuntimeStatus.vision.state !== "READY" && <span>Whiteboard recognition unavailable — drawing still works.</span>}
                    </div>
                  )
                : null
          )}
          {formError !== null && <p className="new-interview__form-error" role="alert">{formError}</p>}
        </div>

        <aside className="new-interview__slip">
          <div className="new-interview__slip-kicker"><span data-ready={String(!launchBlocked)}>{launchBlocked ? "CHECK" : "READY"}</span><span>{providerRouteLabel(selectedProvider)}</span></div>
          <h3>{selectedTarget === null ? "Interview" : MODE_LABELS[selectedTarget.mode]}</h3>
          <p>{selectedTarget?.title ?? "Choose an available target"}</p>
          <div className="new-interview__slip-list">
            <div><span>Model</span><strong>{selectedProvider === null ? "Not selected" : `${providerModelFamilyLabel(selectedProvider)} · ${reasoningTierLabel(selectedReasoningTier)}`}</strong></div>
            <div><span>Intervention</span><strong>{INTERVENTION_LABELS[interventionPolicy]}</strong></div>
            <div><span>Input</span><strong>{mode === "OXFORD_MATHEMATICS" ? "Voice + tldraw + text" : "Structured"}</strong></div>
            <div><span>Duration</span><strong>{durationInvalid ? "Invalid" : durationText.trim().length === 0 ? "Open" : `${durationText} min`}</strong></div>
          </div>
          <button className="new-interview__start" type="submit" disabled={startPending || launchBlocked} data-testid="start-configured-session-btn"><span>{startPending ? "Starting…" : "Start interview"}</span><em aria-hidden="true">→</em></button>
          <div className="new-interview__ready-note"><i data-ready={String(!launchBlocked)} aria-hidden="true" /><span>{activeSessionCount > 1 ? "Resolve the active-session conflict from Sessions." : activeSessionCount > 0 && activeSessionId === null ? "Resolve the stored active session from Sessions." : activeSessionId !== null ? "Current interview owns session authority." : durationInvalid ? "Duration must be a whole number from 5 to 480 minutes." : sessionAuthorityChecking ? "Checking stored session authority…" : sessionAuthorityUnavailable ? "Stored session authority unavailable — retry from Sessions." : launchChecking ? "Revalidating launch readiness…" : metadataUnavailable || selectedTarget === null || selectedProvider?.availability !== "AVAILABLE" ? "Resolve launch readiness first." : "Server revalidates this configuration on start."}</span></div>
        </aside>
      </form>
    </div>
  );
}
