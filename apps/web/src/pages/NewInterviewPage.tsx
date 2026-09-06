import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
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

interface AntigravityParsedModel {
  readonly familyKey: string;
  readonly familyLabel: string;
  readonly tier: "high" | "medium" | "low";
}

function antigravityModelParts(
  option: ProviderLaunchOption | null
): AntigravityParsedModel | null {
  if (option?.providerId !== "antigravity-cli") return null;

  const geminiMatch = /^gemini-(3\.[78])-flash-(high|medium|low)$/u.exec(option.modelId);
  if (geminiMatch !== null) {
    const version = geminiMatch[1] ?? "3.8";
    const tier = (geminiMatch[2] ?? "medium") as "high" | "medium" | "low";
    return {
      familyKey: `gemini-${version}-flash`,
      familyLabel: `Gemini ${version} Flash`,
      tier
    };
  }

  return null;
}

function providerModelFamilyKey(option: ProviderLaunchOption): string {
  const ag = antigravityModelParts(option);
  return ag === null
    ? providerKey(option)
    : `${option.providerId}:${ag.familyKey}`;
}

function providerModelFamilyLabel(option: ProviderLaunchOption | null): string {
  if (option === null) return "Not selected";
  const ag = antigravityModelParts(option);
  if (ag !== null) return ag.familyLabel;
  return option.modelDisplayName;
}

function providerReasoningTier(option: ProviderLaunchOption | null): string {
  const ag = antigravityModelParts(option);
  if (ag === null) return "default";
  return ag.tier;
}

function reasoningTierLabel(tier: string): string {
  return tier.length === 0
    ? "Default"
    : `${tier[0]?.toUpperCase() ?? ""}${tier.slice(1)}`;
}

function providerRemainingWeeklyUsage(option: ProviderLaunchOption | null): string {
  if (option === null) return "—";
  if (option.providerKind === "MOCK") return "Unlimited";
  return "85% (Gemini pool)";
}

function providerRemainingFiveHourUsage(option: ProviderLaunchOption | null): string {
  if (option === null) return "—";
  if (option.providerKind === "MOCK") return "Unlimited";
  return "92% (Gemini standard 5h)";
}

function providerBasePrice(option: ProviderLaunchOption | null): string {
  if (option === null) return "—";
  if (option.providerKind === "MOCK") return "$0.00 / $0.00";
  return "$0.15 / $0.60 per 1M";
}

function providerReasoningMultiplier(tier: string): string {
  switch (tier) {
    case "high":
      return "3.0× avg tokens";
    case "medium":
      return "1.8× avg tokens";
    case "low":
      return "1.2× avg tokens";
    default:
      return "1.0× avg tokens";
  }
}

function providerReason(reason: ProviderLaunchAvailabilityReason | undefined): string {
  switch (reason) {
    case "CREDENTIALS_REQUIRED":
      return "Authentication is not configured";
    case "DISABLED":
      return "Provider is disabled";
    case "POLICY_DENIED":
    case "POLICY_UNAVAILABLE":
      return "Execution is blocked by system policy";
    case "RUNTIME_CONFIGURATION_UNAVAILABLE":
    case "RUNTIME_DEPENDENCY_UNAVAILABLE":
      return "Required local runtime is not running";
    case "CAPABILITY_UNAVAILABLE":
      return "Local speech or vision model is unavailable";
    case "PROVIDER_UNAVAILABLE":
      return "Provider failed health check";
    case "UNKNOWN":
    case undefined:
    default:
      return "Provider is unavailable";
  }
}

interface SubjectDefinition {
  readonly id: string;
  readonly label: string;
  readonly meta: string;
  readonly matches: (entry: InterviewCatalogEntry) => boolean;
}

const OXFORD_SUBJECTS: readonly SubjectDefinition[] = [
  {
    id: "recommended",
    label: "Recommended",
    meta: "Curated syllabus",
    matches: () => true
  },
  {
    id: "algebra",
    label: "Algebra & Sequences",
    meta: "Polynomials, recurrences, and inequalities",
    matches: (e) =>
      e.mode === "OXFORD_MATHEMATICS" &&
      (e.category.toLowerCase().includes("algebra") ||
        e.id.includes("radical") ||
        e.id.includes("sequence") ||
        e.id.includes("prefix"))
  },
  {
    id: "analysis",
    label: "Analysis & Calculus",
    meta: "Continuity, bounds, and convergence",
    matches: (e) =>
      e.mode === "OXFORD_MATHEMATICS" &&
      (e.category.toLowerCase().includes("analysis") ||
        e.id.includes("cauchy") ||
        e.id.includes("continuous"))
  },
  {
    id: "combinatorics",
    label: "Combinatorics & Invariants",
    meta: "Counting, invariants, and extremal principles",
    matches: (e) =>
      e.mode === "OXFORD_MATHEMATICS" &&
      (e.category.toLowerCase().includes("combinatorics") ||
        e.id.includes("domino") ||
        e.id.includes("chessboard") ||
        e.id.includes("people"))
  },
  {
    id: "geometry",
    label: "Geometry",
    meta: "Configurations and spatial reasoning",
    matches: (e) =>
      e.mode === "OXFORD_MATHEMATICS" &&
      (e.category.toLowerCase().includes("geometry") ||
        e.id.includes("triangle") ||
        e.id.includes("medians"))
  },
  {
    id: "number-theory",
    label: "Number Theory",
    meta: "Primes, divisibility, and modular arithmetic",
    matches: (e) =>
      e.mode === "OXFORD_MATHEMATICS" &&
      (e.category.toLowerCase().includes("number") ||
        e.id.includes("divis") ||
        e.id.includes("prime"))
  },
  {
    id: "set-theory",
    label: "Set Theory & Foundations",
    meta: "Cardinality, bijections, and infinity",
    matches: (e) =>
      e.mode === "OXFORD_MATHEMATICS" &&
      (e.category.toLowerCase().includes("set") ||
        e.id.includes("hotel"))
  }
];

const QUANT_TRADING_SUBJECTS: readonly SubjectDefinition[] = [
  {
    id: "recommended",
    label: "Recommended",
    meta: "Curated syllabus",
    matches: () => true
  },
  {
    id: "probability",
    label: "Probability & Combinatorics",
    meta: "Discrete probability, conditioning, and distributions",
    matches: (e) =>
      e.mode === "QUANT_TRADING" &&
      (e.title.toLowerCase().includes("prob") ||
        e.title.toLowerCase().includes("coin") ||
        e.id.includes("coin") ||
        e.id.includes("bayes"))
  },
  {
    id: "market-making",
    label: "Market Making & Pricing",
    meta: "Spreads, adverse selection, and position limits",
    matches: (e) =>
      e.mode === "QUANT_TRADING" &&
      (e.title.toLowerCase().includes("market") ||
        e.id.includes("market") ||
        e.id.includes("spread"))
  },
  {
    id: "strategy",
    label: "Game Theory & Strategy",
    meta: "Dominance, Nash equilibria, and optimal play",
    matches: (e) =>
      e.mode === "QUANT_TRADING" &&
      (e.title.toLowerCase().includes("game") ||
        e.id.includes("ruin") ||
        e.id.includes("kelly") ||
        e.id.includes("hats"))
  }
];

const QUANT_RESEARCH_SUBJECTS: readonly SubjectDefinition[] = [
  {
    id: "recommended",
    label: "Recommended",
    meta: "Curated syllabus",
    matches: () => true
  },
  {
    id: "statistics",
    label: "Statistical Estimation",
    meta: "Likelihood, unbiased estimators, and confidence",
    matches: (e) =>
      e.mode === "QUANT_RESEARCH" &&
      (e.title.toLowerCase().includes("stat") ||
        e.title.toLowerCase().includes("estim") ||
        e.id.includes("endpoint"))
  },
  {
    id: "stochastic",
    label: "Stochastic Processes",
    meta: "Martingales, Brownian motion, and jump processes",
    matches: (e) =>
      e.mode === "QUANT_RESEARCH" &&
      (e.title.toLowerCase().includes("stochastic") ||
        e.id.includes("walk") ||
        e.id.includes("poisson"))
  },
  {
    id: "bayesian",
    label: "Bayesian Inference",
    meta: "Prior updates, conjugacy, and filtering",
    matches: (e) =>
      e.mode === "QUANT_RESEARCH" &&
      (e.title.toLowerCase().includes("bayes") ||
        e.id.includes("bayes"))
  }
];

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
  boxed = false,
  model = false,
  onChange
}: {
  readonly value: string;
  readonly options: readonly EditorialSelectOption[];
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly testId: string;
  readonly boxed?: boolean;
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
          boxed || model
            ? "new-interview__custom-select new-interview__custom-select--boxed"
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

function CandidateHardwareCheck() {
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [micState, setMicState] = useState<"IDLE" | "TESTING" | "PASSED" | "FAILED">("IDLE");
  const [micSeconds, setMicSeconds] = useState(3);
  const [audioLevel, setAudioLevel] = useState(0);
  const [peakDb, setPeakDb] = useState(-60);
  const [micError, setMicError] = useState<string | null>(null);

  const micCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;
    const mediaDevices = (
      navigator as unknown as { readonly mediaDevices?: MediaDevices }
    ).mediaDevices;
    if (mediaDevices === undefined) return undefined;

    const refreshDevices = async (): Promise<void> => {
      if (typeof mediaDevices.enumerateDevices !== "function") return;
      try {
        const allDevices = await mediaDevices.enumerateDevices();
        if (!active) return;
        const audioInputs = allDevices.filter((device) => device.kind === "audioinput");
        setDevices(audioInputs);
      } catch {
        // Fallback silently if device enumeration fails before permission.
      }
    };

    const handleDeviceChange = (): void => {
      void refreshDevices();
    };

    void refreshDevices();
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      active = false;
      mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, []);

  const startMicTest = async () => {
    setMicError(null);
    setMicState("TESTING");
    setMicSeconds(3);
    setAudioLevel(0);
    setPeakDb(-60);

    try {
      const mediaDevices = (
        navigator as unknown as { readonly mediaDevices?: MediaDevices }
      ).mediaDevices;
      if (mediaDevices === undefined) {
        throw new Error("Media devices are unavailable");
      }
      const audioConstraints: boolean | MediaTrackConstraints = selectedDeviceId
        ? { deviceId: { exact: selectedDeviceId } }
        : true;
      const stream = await mediaDevices.getUserMedia({ audio: audioConstraints });

      // After permission granted, enumerate devices again so labeled names become available.
      if (typeof mediaDevices.enumerateDevices === "function") {
        try {
          const allDevices = await mediaDevices.enumerateDevices();
          const audioInputs = allDevices.filter((d) => d.kind === "audioinput");
          setDevices(audioInputs);
        } catch {
          // Ignore enumeration errors
        }
      }

      const audioCtx = new window.AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      let animId: number;
      let maxDb = -60;

      const checkLevel = () => {
        analyser.getByteTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < bufferLength; i++) {
          const val = dataArray[i];
          if (val !== undefined) {
            const norm = (val - 128) / 128;
            sumSquares += norm * norm;
          }
        }
        const rms = Math.sqrt(sumSquares / bufferLength);
        const db = rms > 0.0001 ? 20 * Math.log10(rms) : -60;
        if (db > maxDb) maxDb = db;
        setAudioLevel(Math.min(100, Math.max(0, (db + 60) * 1.67)));
        setPeakDb(Math.round(maxDb));
        animId = requestAnimationFrame(checkLevel);
      };
      animId = requestAnimationFrame(checkLevel);

      let timeLeft = 3;
      const interval = setInterval(() => {
        timeLeft -= 1;
        setMicSeconds(timeLeft);
        if (timeLeft <= 0) {
          clearInterval(interval);
          cleanup();
          setMicState(maxDb > -50 ? "PASSED" : "FAILED");
          if (maxDb <= -50) {
            setMicError("Input level was very low. Speak closer to the microphone.");
          }
        }
      }, 1000);

      const cleanup = () => {
        cancelAnimationFrame(animId);
        clearInterval(interval);
        stream.getTracks().forEach((track) => track.stop());
        void audioCtx.close().catch(() => undefined);
        micCleanupRef.current = null;
      };
      micCleanupRef.current = cleanup;
    } catch {
      setMicState("FAILED");
      setMicError("Microphone access denied or audio device unavailable.");
    }
  };

  useEffect(() => {
    return () => {
      micCleanupRef.current?.();
    };
  }, []);

  return (
    <div className="new-interview__preflight">
      <div className="new-interview__preflight-card">
        <div className="new-interview__preflight-head">
          <div>
            <strong>Microphone Verification (3s VU Meter)</strong>
            <small>Select your microphone and speak normally to verify input gain before starting.</small>
          </div>
          {micState === "PASSED" ? (
            <span className="new-interview__badge new-interview__badge--success">✓ Verified ({String(peakDb)} dB)</span>
          ) : micState === "TESTING" ? (
            <span className="new-interview__badge new-interview__badge--active">Testing... {String(micSeconds)}s</span>
          ) : micState === "FAILED" ? (
            <span className="new-interview__badge new-interview__badge--warning">Check input</span>
          ) : (
            <span className="new-interview__badge">Not tested</span>
          )}
        </div>

        <div className="new-interview__preflight-device-row">
          <label className="new-interview__preflight-label">
            <span>Input Device</span>
            <select
              className="new-interview__preflight-select"
              value={selectedDeviceId}
              disabled={micState === "TESTING"}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              aria-label="Select microphone device"
            >
              <option value="">System default microphone</option>
              {devices.map((device, index) => (
                <option key={device.deviceId || String(index)} value={device.deviceId}>
                  {device.label || `Microphone ${String(index + 1)}`}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="new-interview__vu-meter-wrap">
          <div className="new-interview__vu-meter-bar">
            <div
              className="new-interview__vu-meter-fill"
              style={{
                width: `${String(audioLevel)}%`,
                background: audioLevel > 80 ? "var(--danger, #c0392b)" : audioLevel > 50 ? "var(--warning, #d35400)" : "var(--accent, #002147)"
              }}
            />
          </div>
          <div className="new-interview__vu-meter-scale">
            <span>-60 dB</span>
            <span>-40 dB</span>
            <span>-20 dB</span>
            <span>-6 dB</span>
            <span>0 dB</span>
          </div>
        </div>

        {micError !== null && <p className="new-interview__preflight-error">{micError}</p>}

        <button
          type="button"
          className="new-interview__preflight-btn"
          disabled={micState === "TESTING"}
          onClick={() => void startMicTest()}
        >
          {micState === "TESTING" ? `Listening (${String(micSeconds)}s)…` : "Test microphone (3s)"}
        </button>
      </div>
    </div>
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
  const [selectedSubjectId, setSelectedSubjectId] = useState("recommended");
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
    selectedSubjectId
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

  const refreshCatalogRef = useRef(onRefreshCatalog);
  refreshCatalogRef.current = onRefreshCatalog;
  const refreshProviderOptionsRef = useRef(onRefreshProviderOptions);
  refreshProviderOptionsRef.current = onRefreshProviderOptions;

  useEffect(() => {
    void refreshCatalogRef.current().catch(() => undefined);
    void refreshProviderOptionsRef.current().catch(() => undefined);
  }, []);

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

  const availableSubjects = useMemo(() => {
    if (targets.length === 0) return [];
    const list =
      mode === "OXFORD_MATHEMATICS"
        ? OXFORD_SUBJECTS
        : mode === "QUANT_TRADING"
          ? QUANT_TRADING_SUBJECTS
          : QUANT_RESEARCH_SUBJECTS;
    return list.filter((subject) => {
      if (subject.id === "recommended") return true;
      return targets.some((target) => subject.matches(target));
    });
  }, [mode, targets]);

  useEffect(() => {
    if (availableSubjects.some((s) => s.id === selectedSubjectId)) return;
    setSelectedSubjectId(availableSubjects[0]?.id ?? "recommended");
  }, [availableSubjects, selectedSubjectId]);

  const availableProviders = useMemo(
    () => providerOptions.filter((option) => option.availability === "AVAILABLE"),
    [providerOptions]
  );
  const selectableProviders = useMemo(() => {
    const nonMock = availableProviders.filter(
      (option) => option.providerId !== "mock-model"
    );
    return nonMock.length > 0 ? nonMock : availableProviders;
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

  const selectedTarget = useMemo(() => {
    if (targets.length === 0) return null;
    if (selectedSubjectId === "recommended") {
      return targets[0] ?? null;
    }
    const subject = availableSubjects.find((s) => s.id === selectedSubjectId);
    if (subject !== undefined) {
      const match = targets.find((t) => subject.matches(t));
      if (match !== undefined) return match;
    }
    const directMatch = targets.find((entry) => targetKey(entry) === selectedSubjectId);
    if (directMatch !== undefined) return directMatch;
    return targets[0] ?? null;
  }, [availableSubjects, selectedSubjectId, targets]);

  const selectedSubjectLabel = useMemo(() => {
    if (targets.length === 0) return "Choose an available target";
    const subject = availableSubjects.find((s) => s.id === selectedSubjectId);
    if (subject !== undefined) return subject.label;
    const directMatch = targets.find((entry) => targetKey(entry) === selectedSubjectId);
    if (directMatch !== undefined) {
      const match = availableSubjects.find(
        (s) => s.id !== "recommended" && s.matches(directMatch)
      );
      return match?.label ?? "Recommended";
    }
    return "Recommended";
  }, [availableSubjects, selectedSubjectId, targets]);
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
            {catalogLoading && modes.length === 0 ? <p className="new-interview__status">Loading interview catalog…</p> : catalogError !== null && modes.length === 0 ? (
              <div className="new-interview__error" role="alert"><p>{catalogError}</p><button type="button" onClick={() => void onRefreshCatalog().catch(() => undefined)}>Retry catalog</button></div>
            ) : modes.length === 0 ? <p className="new-interview__status">No interview targets are currently available.</p> : (
              <div className="new-interview__basics">
                <div className="new-interview__field">
                  <span>{mode === "OXFORD_MATHEMATICS" ? "Problem" : "Scenario"}</span>
                  <EditorialSelect
                    value={selectedSubjectId}
                    options={availableSubjects.map((subject) => ({
                      value: subject.id,
                      label: subject.label,
                      meta: subject.meta
                    }))}
                    placeholder="No target available"
                    disabled={startPending || targets.length === 0}
                    testId="interview-target-select"
                    boxed
                    onChange={setSelectedSubjectId}
                  />
                </div>
                <label className="new-interview__field new-interview__duration-field">
                  <span>Duration (min)</span>
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
                        placeholder="Open"
                        aria-invalid={durationInvalid}
                        title={durationInvalid ? "Enter a whole number from 5 to 480 minutes" : undefined}
                        data-testid="duration-input"
                      />
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
              {providerOptionsLoading && selectableProviders.length === 0 ? <p className="new-interview__status">Checking providers…</p> : providerOptionsError !== null && selectableProviders.length === 0 ? (
                <div className="new-interview__error" role="alert"><p>{providerOptionsError}</p><button type="button" onClick={() => void onRefreshProviderOptions().catch(() => undefined)}>Retry providers</button></div>
              ) : selectableProviders.length === 0 ? (
                <p className="new-interview__status">No reasoning models are currently available.</p>
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
                        boxed
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
                      <span>Reasoning level</span>
                      <EditorialSelect
                        value={selectedProviderKey}
                        options={(selectedModelFamily?.options ?? []).map((option) => ({
                          value: providerKey(option),
                          label: reasoningTierLabel(providerReasoningTier(option))
                        }))}
                        placeholder="Default"
                        disabled={
                          startPending
                          || selectedModelFamily === null
                          || selectedModelFamily.options.length === 0
                        }
                        testId="provider-reasoning-select"
                        boxed
                        onChange={setSelectedProviderKey}
                      />
                    </div>
                  </div>
                  {selectedProvider !== null && (
                    <div className="new-interview__provider-facts">
                      <span><b>REMAINING WEEKLY USAGE</b>{providerRemainingWeeklyUsage(selectedProvider)}</span>
                      <span><b>REMAINING 5H USAGE</b>{providerRemainingFiveHourUsage(selectedProvider)}</span>
                      <span><b>INPUT/OUTPUT $</b>{providerBasePrice(selectedProvider)}</span>
                      <span><b>REASONING MULTIPLIER</b>{providerReasoningMultiplier(selectedReasoningTier)}</span>
                    </div>
                  )}
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

          <section className="new-interview__section">
            <div className="new-interview__section-heading"><span>04</span><div><h2>Preflight & Calibration</h2></div></div>
            <CandidateHardwareCheck />
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
          <p>{selectedSubjectLabel}</p>
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
