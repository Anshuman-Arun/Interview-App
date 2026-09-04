import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties
} from "react";
import type {
  ProviderLaunchAvailabilityReason,
  ProviderLaunchOption
} from "../../../../packages/domain/src/index.js";
import type {
  BorderStyle,
  CornerStyle,
  ThemeMode
} from "../appearance/appearance.js";
import {
  ACCENT_OPTIONS,
  MAX_INTERFACE_ZOOM_PERCENT,
  MIN_INTERFACE_ZOOM_PERCENT
} from "../appearance/appearance.js";
import { useAppearance } from "../appearance/AppearanceProvider.js";
import {
  DESKTOP_FIRST_RUN_SETUP_KEY,
  getDesktopRuntimeBridge,
  parseDesktopRuntimeStatus,
  readDesktopRuntimeStatus,
  type DesktopModelSetupStatus,
  type DesktopRuntimeCapabilityStatus,
  type DesktopRuntimeStatus
} from "../desktop-runtime.js";
import "./SettingsPage.css";

interface SettingsPageProps {
  readonly connection?: {
    readonly managed: boolean;
    readonly baseUrl: string;
    readonly locked: boolean;
    readonly onSaveBaseUrl: (baseUrl: string) => void;
  };
  readonly providerOptions?: readonly ProviderLaunchOption[];
  readonly providerOptionsLoading?: boolean;
  readonly providerOptionsError?: string | null;
  readonly onRefreshProviderOptions?: () => Promise<readonly ProviderLaunchOption[]>;
  readonly onStartInterview?: () => void;
}

function isAntigravity(option: ProviderLaunchOption): boolean {
  return option.providerId.toLowerCase().includes("antigravity")
    || option.providerDisplayName.toLowerCase().includes("antigravity");
}

function capabilityLabel(
  capability: DesktopRuntimeCapabilityStatus | undefined,
  setup?: DesktopModelSetupStatus
): string {
  if (setup?.restartRequired === true && capability?.state !== "READY") {
    return "RESTART REQUIRED";
  }
  switch (capability?.state) {
    case "READY":
      return "READY";
    case "MISSING_ASSET":
      return "NOT INSTALLED";
    case "FAILED":
      return "FAILED";
    case "UNAVAILABLE":
      return "UNAVAILABLE";
    case undefined:
      return "CHECKING";
  }
}

function capabilityTone(
  capability: DesktopRuntimeCapabilityStatus | undefined,
  setup?: DesktopModelSetupStatus
): "ready" | "warning" | "error" | "muted" {
  if (setup?.restartRequired === true && capability?.state !== "READY") return "warning";
  switch (capability?.state) {
    case "READY":
      return "ready";
    case "MISSING_ASSET":
      return "warning";
    case "FAILED":
      return "error";
    case "UNAVAILABLE":
    case undefined:
      return "muted";
  }
}

function pythonDescription(status: DesktopRuntimeStatus | undefined): string {
  if (status === undefined) return "Checking the local Python worker runtime.";
  switch (status.python.reasonCode) {
    case "PYTHON_RUNTIME_UNAVAILABLE":
      return "Python is required for local speech and whiteboard understanding. Install 64-bit CPython 3.12 or 3.13, then re-check.";
    case "PYTHON_RUNTIME_INCOMPATIBLE":
      return "Interview App found Python, but it is not a supported 64-bit CPython 3.12/3.13 runtime with the required local packages.";
    case "UNSUPPORTED_RUNTIME_PLATFORM":
      return "Local speech and vision are unavailable on this platform or architecture.";
    case "WORKER_EXECUTABLE_UNAVAILABLE":
      return "The verified local worker files are unavailable. Reinstall Interview App to repair them.";
    default:
      return status.python.state === "READY"
        ? "Supported 64-bit CPython 3.12 / 3.13 runtime verified."
        : "The local Python runtime could not be verified.";
  }
}

function providerReason(reason: ProviderLaunchAvailabilityReason | undefined): string {
  switch (reason) {
    case "CREDENTIALS_REQUIRED":
      return "Authenticate Antigravity through its CLI, then re-check.";
    case "RUNTIME_DEPENDENCY_UNAVAILABLE":
      return "The local Antigravity runtime could not be verified.";
    case "RUNTIME_CONFIGURATION_UNAVAILABLE":
      return "Antigravity runtime configuration is unavailable.";
    case "CAPABILITY_UNAVAILABLE":
      return "The configured model cannot provide the required reasoning capability.";
    case "DISABLED":
      return "Antigravity is disabled by runtime configuration.";
    case "POLICY_DENIED":
      return "Antigravity is unavailable under the current provider policy.";
    case "POLICY_UNAVAILABLE":
      return "Provider safety policy could not be verified.";
    case "PROVIDER_UNAVAILABLE":
      return "Antigravity is not currently executable.";
    case "UNKNOWN":
    default:
      return "Antigravity readiness could not be verified.";
  }
}

function setupActionLabel(
  noun: "voice models" | "vision model",
  setup: DesktopModelSetupStatus | undefined,
  ready: boolean
): string {
  if (ready) return noun === "voice models" ? "Voice ready" : "Vision ready";
  if (setup?.state === "INSTALLING") return "INSTALLING…";
  if (setup?.restartRequired === true) return "Installed — restart required";
  if (setup?.state === "FAILED") return `Retry ${noun}`;
  return `Install ${noun}`;
}

export function SettingsPage({
  connection,
  providerOptions = [],
  providerOptionsLoading = false,
  providerOptionsError = null,
  onRefreshProviderOptions,
  onStartInterview
}: SettingsPageProps) {
  const [draftBaseUrl, setDraftBaseUrl] = useState(connection?.baseUrl ?? "");
  const desktopRuntime = useMemo(() => getDesktopRuntimeBridge(), []);
  const [runtimeStatus, setRuntimeStatus] = useState<DesktopRuntimeStatus | undefined>();
  const [runtimeStatusError, setRuntimeStatusError] = useState<string | undefined>();
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const [installingVoice, setInstallingVoice] = useState(false);
  const [installingVision, setInstallingVision] = useState(false);
  const [voiceInstallError, setVoiceInstallError] = useState<string | undefined>();
  const [visionInstallError, setVisionInstallError] = useState<string | undefined>();
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    setDraftBaseUrl(connection?.baseUrl ?? "");
  }, [connection?.baseUrl]);

  const refreshRuntime = useCallback(async (): Promise<void> => {
    if (desktopRuntime === undefined) {
      setRuntimeStatus(undefined);
      setRuntimeStatusError(undefined);
      return;
    }
    setRuntimeChecking(true);
    try {
      setRuntimeStatus(await readDesktopRuntimeStatus(desktopRuntime));
      setRuntimeStatusError(undefined);
    } catch {
      setRuntimeStatus(undefined);
      setRuntimeStatusError(
        "Local runtime status could not be verified. Re-check or restart Interview App."
      );
    } finally {
      setRuntimeChecking(false);
    }
  }, [desktopRuntime]);

  useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  useEffect(() => {
    if (onRefreshProviderOptions === undefined) return;
    void onRefreshProviderOptions().catch(() => undefined);
  }, [onRefreshProviderOptions]);

  const {
    settings,
    setTheme,
    setAccent,
    setAccentIntensity,
    setZoomPercent,
    setCorners,
    setBorders,
    reset
  } = useAppearance();

  const themes: readonly ThemeMode[] = ["system", "light", "dark"];
  const corners: readonly CornerStyle[] = ["square", "soft", "round", "generous"];
  const borders: readonly BorderStyle[] = ["quiet", "regular", "strong", "contrast"];

  const antigravity = providerOptions.find(isAntigravity);
  const reasoningReady = antigravity?.availability === "AVAILABLE";
  const voiceReady = runtimeStatus?.speech.state === "READY"
    && runtimeStatus.tts.state === "READY";
  const visionReady = runtimeStatus?.vision.state === "READY";
  const anyInstallActive = installingVoice
    || installingVision
    || runtimeStatus?.voiceSetup.state === "INSTALLING"
    || runtimeStatus?.visionSetup.state === "INSTALLING";
  const pythonReady = runtimeStatus?.python.state === "READY";
  const restartRequired = runtimeStatus?.voiceSetup.restartRequired === true
    || runtimeStatus?.visionSetup.restartRequired === true;

  const runInstall = useCallback(async (
    kind: "VOICE" | "VISION"
  ): Promise<void> => {
    if (desktopRuntime === undefined) return;
    const operation = kind === "VOICE"
      ? desktopRuntime.installVoiceModels
      : desktopRuntime.installVisionModel;
    if (operation === undefined) {
      if (kind === "VOICE") {
        setVoiceInstallError("This desktop build does not expose voice model setup.");
      } else {
        setVisionInstallError("This desktop build does not expose vision model setup.");
      }
      return;
    }

    if (kind === "VOICE") {
      setInstallingVoice(true);
      setVoiceInstallError(undefined);
    } else {
      setInstallingVision(true);
      setVisionInstallError(undefined);
    }
    try {
      const parsed = parseDesktopRuntimeStatus(await operation());
      if (parsed === undefined) throw new Error("Malformed model setup response");
      setRuntimeStatus(parsed);
      setRuntimeStatusError(undefined);
    } catch {
      if (kind === "VOICE") {
        setVoiceInstallError(
          "Voice model installation failed. Check Python, network access, and disk space, then retry."
        );
      } else {
        setVisionInstallError(
          "Vision model installation failed. Check Python, network access, and disk space, then retry."
        );
      }
      await refreshRuntime();
    } finally {
      if (kind === "VOICE") setInstallingVoice(false);
      else setInstallingVision(false);
    }
  }, [desktopRuntime, refreshRuntime]);

  const recheckAll = useCallback(async (): Promise<void> => {
    const providerCheck = onRefreshProviderOptions?.().catch(() => undefined);
    await Promise.all([
      refreshRuntime(),
      providerCheck ?? Promise.resolve()
    ]);
  }, [onRefreshProviderOptions, refreshRuntime]);

  const finishSetup = (): void => {
    try {
      globalThis.localStorage.setItem(DESKTOP_FIRST_RUN_SETUP_KEY, "complete");
    } catch {
      // First-run routing is a convenience; runtime authority never depends on storage.
    }
    onStartInterview?.();
  };

  const summary = reasoningReady
    ? (
      voiceReady && visionReady
        ? "Ready to interview. Voice and whiteboard understanding are active."
        : `Typed interviews are ready.${voiceReady ? "" : " Voice is unavailable."}${visionReady ? "" : " Whiteboard semantic understanding is unavailable."}`
    )
    : "A live AI interview needs a ready reasoning provider. Voice and whiteboard understanding remain optional.";

  return (
    <div className="expressive-settings">
      <section
        className="expressive-settings__readiness"
        data-testid="local-ai-readiness"
      >
        <div className="expressive-settings__readiness-heading">
          <div>
            <span>LOCAL AI</span>
            <h2>Interview readiness</h2>
            <p>
              Configure optional local capabilities here. Typed interviews do not
              require voice or whiteboard recognition.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void recheckAll()}
            disabled={runtimeChecking || providerOptionsLoading || anyInstallActive}
          >
            {runtimeChecking || providerOptionsLoading ? "Checking…" : "Re-check"}
          </button>
        </div>

        <div className="expressive-settings__status-list" aria-live="polite">
          <div className="expressive-settings__status-row">
            <div>
              <span>Reasoning</span>
              <strong>{antigravity?.providerDisplayName ?? "Antigravity CLI"}</strong>
              <small>{antigravity?.modelDisplayName ?? "Gemini 3.7 Flash Medium"}</small>
            </div>
            <div>
              <b data-state={reasoningReady ? "ready" : "muted"}>
                {providerOptionsLoading
                  ? "CHECKING"
                  : reasoningReady
                    ? "READY"
                    : "UNAVAILABLE"}
              </b>
              {!reasoningReady && !providerOptionsLoading && (
                <small>
                  {providerOptionsError
                    ?? (antigravity === undefined
                      ? "Antigravity is not registered in the current server runtime."
                      : providerReason(antigravity.reason))}
                </small>
              )}
            </div>
          </div>

          <div className="expressive-settings__status-row">
            <div>
              <span>Voice input</span>
              <strong>Silero + Moonshine</strong>
            </div>
            <div>
              <b data-state={capabilityTone(runtimeStatus?.speech, runtimeStatus?.voiceSetup)}>
                {desktopRuntime === undefined
                  ? "DESKTOP ONLY"
                  : capabilityLabel(runtimeStatus?.speech, runtimeStatus?.voiceSetup)}
              </b>
            </div>
          </div>

          <div className="expressive-settings__status-row">
            <div>
              <span>Voice output</span>
              <strong>Kokoro</strong>
            </div>
            <div>
              <b data-state={capabilityTone(runtimeStatus?.tts, runtimeStatus?.voiceSetup)}>
                {desktopRuntime === undefined
                  ? "DESKTOP ONLY"
                  : capabilityLabel(runtimeStatus?.tts, runtimeStatus?.voiceSetup)}
              </b>
            </div>
          </div>

          <div className="expressive-settings__status-row">
            <div>
              <span>Whiteboard understanding</span>
              <strong>Local vision</strong>
            </div>
            <div>
              <b data-state={capabilityTone(runtimeStatus?.vision, runtimeStatus?.visionSetup)}>
                {desktopRuntime === undefined
                  ? "DESKTOP ONLY"
                  : capabilityLabel(runtimeStatus?.vision, runtimeStatus?.visionSetup)}
              </b>
            </div>
          </div>

          <div className="expressive-settings__status-row">
            <div>
              <span>Runtime</span>
              <strong>64-bit CPython 3.12 / 3.13</strong>
            </div>
            <div>
              <b data-state={capabilityTone(runtimeStatus?.python)}>
                {desktopRuntime === undefined
                  ? "DESKTOP ONLY"
                  : capabilityLabel(runtimeStatus?.python)}
              </b>
              <small>
                {desktopRuntime === undefined
                  ? "Local workers are configured only in the Electron desktop app."
                  : runtimeStatusError ?? pythonDescription(runtimeStatus)}
              </small>
            </div>
          </div>
        </div>

        {desktopRuntime !== undefined && (
          <div className="expressive-settings__setup-actions">
            <div>
              <div>
                <strong>Speech and voice</strong>
                <small>
                  {runtimeStatus?.voiceSetup.restartRequired === true
                    ? "Installed. Restart Interview App to activate the running workers."
                    : voiceReady
                      ? "Speech input and voice output are active."
                      : "Silero, Moonshine, and Kokoro are optional verified local models."}
                </small>
                {voiceInstallError !== undefined && (
                  <small className="expressive-settings__setup-error">{voiceInstallError}</small>
                )}
              </div>
              <button
                type="button"
                onClick={() => void runInstall("VOICE")}
                disabled={
                  anyInstallActive
                  || runtimeStatus === undefined
                  || !pythonReady
                  || voiceReady
                  || runtimeStatus.voiceSetup.restartRequired
                }
              >
                {installingVoice
                  ? "INSTALLING…"
                  : setupActionLabel("voice models", runtimeStatus?.voiceSetup, voiceReady)}
              </button>
            </div>

            <div>
              <div>
                <strong>Whiteboard understanding</strong>
                <small>
                  {runtimeStatus?.visionSetup.restartRequired === true
                    ? "Installed. Restart Interview App to activate local vision."
                    : visionReady
                      ? "Whiteboard semantic recognition is active."
                      : "Drawing remains available even when local vision is not installed."}
                </small>
                {visionInstallError !== undefined && (
                  <small className="expressive-settings__setup-error">{visionInstallError}</small>
                )}
              </div>
              <button
                type="button"
                onClick={() => void runInstall("VISION")}
                disabled={
                  anyInstallActive
                  || runtimeStatus === undefined
                  || !pythonReady
                  || visionReady
                  || runtimeStatus.visionSetup.restartRequired
                }
              >
                {installingVision
                  ? "INSTALLING…"
                  : setupActionLabel("vision model", runtimeStatus?.visionSetup, visionReady)}
              </button>
            </div>

            {runtimeStatus !== undefined && !pythonReady && (
              <p className="expressive-settings__python-help">
                {pythonDescription(runtimeStatus)}
              </p>
            )}
          </div>
        )}

        <div className="expressive-settings__finish">
          <p>{summary}</p>
          <div>
            {restartRequired && (
              <button
                type="button"
                onClick={() => {
                  if (desktopRuntime?.restartApp === undefined) return;
                  setRestarting(true);
                  void desktopRuntime.restartApp().catch(() => {
                    setRestarting(false);
                    setRuntimeStatusError(
                      "Interview App could not restart automatically. Close and reopen the app."
                    );
                  });
                }}
                disabled={restarting || anyInstallActive}
              >
                {restarting ? "Restarting…" : "Restart Interview App"}
              </button>
            )}
            {onStartInterview !== undefined && (
              <button
                type="button"
                className="expressive-settings__start"
                onClick={finishSetup}
                disabled={!reasoningReady || providerOptionsLoading}
              >
                Start interview
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="expressive-settings__intro">
        <div>
          <span>ROOM TUNING</span>
          <h2>Make the interface disappear in the right way.</h2>
        </div>
        <button type="button" onClick={reset}>Reset appearance</button>
      </section>

      <section className="expressive-settings__row">
        <div className="expressive-settings__copy">
          <span>01</span>
          <div>
            <h3>Theme</h3>
            <p>Follow the system or pin the room to light or dark.</p>
          </div>
        </div>
        <div className="expressive-settings__control expressive-settings__segments">
          {themes.map((theme) => (
            <button
              key={theme}
              type="button"
              aria-pressed={settings.theme === theme}
              onClick={() => setTheme(theme)}
            >
              {theme}
            </button>
          ))}
        </div>
      </section>

      <section className="expressive-settings__row">
        <div className="expressive-settings__copy">
          <span>02</span>
          <div>
            <h3>Accent</h3>
            <p>Keep chrome distinct from the whiteboard drawing palette.</p>
          </div>
        </div>
        <div className="expressive-settings__control">
          <div className="expressive-settings__swatches">
            {ACCENT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-label={option.label}
                aria-pressed={settings.accent === option.id}
                style={{ "--swatch": option.color } as React.CSSProperties}
                onClick={() => setAccent(option.id)}
              />
            ))}
          </div>
          <label className="expressive-settings__range">
            <span>Intensity</span>
            <input
              type="range"
              min="8"
              max="28"
              value={settings.accentIntensity}
              onChange={(event) => setAccentIntensity(Number(event.target.value))}
            />
          </label>
        </div>
      </section>

      <section className="expressive-settings__row">
        <div className="expressive-settings__copy">
          <span>03</span>
          <div>
            <h3>Shape & border</h3>
            <p>Adjust geometry without adding shadows, blur, or visual noise.</p>
          </div>
        </div>
        <div className="expressive-settings__control expressive-settings__dual">
          <div>
            <small>Corners</small>
            <div className="expressive-settings__chips">
              {corners.map((corner) => (
                <button
                  key={corner}
                  type="button"
                  aria-pressed={settings.corners === corner}
                  onClick={() => setCorners(corner)}
                >
                  {corner}
                </button>
              ))}
            </div>
          </div>
          <div>
            <small>Borders</small>
            <div className="expressive-settings__chips">
              {borders.map((border) => (
                <button
                  key={border}
                  type="button"
                  aria-pressed={settings.borders === border}
                  onClick={() => setBorders(border)}
                >
                  {border}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="expressive-settings__row">
        <div className="expressive-settings__copy">
          <span>04</span>
          <div>
            <h3>Zoom</h3>
            <p>Use any percentage, just like a normal app zoom control.</p>
          </div>
        </div>
        <div className="expressive-settings__control expressive-settings__zoom">
          <div className="expressive-settings__zoom-stepper">
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => setZoomPercent(settings.zoomPercent - 10)}
              disabled={settings.zoomPercent <= MIN_INTERFACE_ZOOM_PERCENT}
            >
              −
            </button>
            <label>
              <input
                key={settings.zoomPercent}
                type="number"
                min={MIN_INTERFACE_ZOOM_PERCENT}
                max={MAX_INTERFACE_ZOOM_PERCENT}
                step="1"
                defaultValue={settings.zoomPercent}
                aria-label="Interface zoom percent"
                onBlur={(event) => {
                  const raw = event.currentTarget.value.trim();
                  if (raw.length === 0) {
                    event.currentTarget.value = String(settings.zoomPercent);
                    return;
                  }
                  const next = Number(raw);
                  if (!Number.isFinite(next)) {
                    event.currentTarget.value = String(settings.zoomPercent);
                    return;
                  }
                  const normalized = Math.min(
                    MAX_INTERFACE_ZOOM_PERCENT,
                    Math.max(MIN_INTERFACE_ZOOM_PERCENT, Math.round(next))
                  );
                  event.currentTarget.value = String(normalized);
                  setZoomPercent(normalized);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.currentTarget.value = String(settings.zoomPercent);
                    event.currentTarget.blur();
                  }
                }}
              />
              <span>%</span>
            </label>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => setZoomPercent(settings.zoomPercent + 10)}
              disabled={settings.zoomPercent >= MAX_INTERFACE_ZOOM_PERCENT}
            >
              +
            </button>
            <button
              type="button"
              className="expressive-settings__zoom-reset"
              onClick={() => setZoomPercent(100)}
              disabled={settings.zoomPercent === 100}
            >
              Reset
            </button>
          </div>
          <input
            type="range"
            min={MIN_INTERFACE_ZOOM_PERCENT}
            max={MAX_INTERFACE_ZOOM_PERCENT}
            step="1"
            value={settings.zoomPercent}
            aria-label="Interface zoom"
            onChange={(event) => setZoomPercent(Number(event.target.value))}
          />
        </div>
      </section>

      {connection !== undefined && (
        <section className="expressive-settings__row">
          <div className="expressive-settings__copy">
            <span>05</span>
            <div>
              <h3>Local connection</h3>
              <p>
                {connection.managed
                  ? "The trusted desktop runtime owns this connection."
                  : connection.locked
                    ? "Connection changes are locked while an interview is active."
                    : "Browser-only loopback origin."}
              </p>
            </div>
          </div>
          <div className="expressive-settings__control expressive-settings__connection">
            {connection.managed ? (
              <div className="expressive-settings__managed">
                <span>Desktop managed</span>
                <code>{connection.baseUrl}</code>
              </div>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (connection.locked) return;
                  connection.onSaveBaseUrl(draftBaseUrl.trim());
                }}
              >
                <input
                  type="url"
                  value={draftBaseUrl}
                  onChange={(event) => setDraftBaseUrl(event.target.value)}
                  disabled={connection.locked}
                  aria-label="Loopback command URL"
                  placeholder="http://127.0.0.1:43123"
                />
                <button
                  type="submit"
                  disabled={connection.locked || draftBaseUrl.trim().length === 0}
                >
                  Apply
                </button>
              </form>
            )}
          </div>
        </section>
      )}

    </div>
  );
}
