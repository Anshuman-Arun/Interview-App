import { useEffect, useState } from "react";
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
import "./SettingsPage.css";

type DesktopRuntimeCapabilityState = "READY" | "MISSING_ASSET" | "FAILED" | "UNAVAILABLE";
type DesktopModelSetupState = "IDLE" | "INSTALLING" | "INSTALLED" | "FAILED";

interface DesktopRuntimeStatus {
  readonly protocolVersion: 1;
  readonly speech: { readonly state: DesktopRuntimeCapabilityState; readonly reasonCode?: string };
  readonly tts: { readonly state: DesktopRuntimeCapabilityState; readonly reasonCode?: string };
  readonly python: {
    readonly strategy: "SYSTEM_CPYTHON";
    readonly supportedVersions: readonly ["3.12", "3.13"];
  };
  readonly modelSetup: {
    readonly state: DesktopModelSetupState;
    readonly restartRequired: boolean;
  };
}

interface DesktopRuntimeBridge {
  readonly getLocalRuntimeStatus?: () => Promise<unknown>;
  readonly installLocalModels?: () => Promise<unknown>;
}

function getDesktopRuntimeBridge(): Required<DesktopRuntimeBridge> | undefined {
  const bridge = (globalThis as typeof globalThis & {
    readonly interviewDesktop?: DesktopRuntimeBridge;
  }).interviewDesktop;
  if (
    bridge === undefined
    || typeof bridge.getLocalRuntimeStatus !== "function"
    || typeof bridge.installLocalModels !== "function"
  ) {
    return undefined;
  }
  return bridge as Required<DesktopRuntimeBridge>;
}

function parseDesktopRuntimeStatus(value: unknown): DesktopRuntimeStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const speech = parseCapability(record["speech"]);
  const tts = parseCapability(record["tts"]);
  const python = record["python"];
  const modelSetup = record["modelSetup"];
  if (
    record["protocolVersion"] !== 1
    || speech === undefined
    || tts === undefined
    || typeof python !== "object"
    || python === null
    || (python as Record<string, unknown>)["strategy"] !== "SYSTEM_CPYTHON"
    || !Array.isArray((python as Record<string, unknown>)["supportedVersions"])
    || typeof modelSetup !== "object"
    || modelSetup === null
  ) {
    return undefined;
  }
  const versions = (python as Record<string, unknown>)["supportedVersions"] as unknown[];
  const setup = modelSetup as Record<string, unknown>;
  const setupState = setup["state"];
  if (
    versions.length !== 2
    || versions[0] !== "3.12"
    || versions[1] !== "3.13"
    || !["IDLE", "INSTALLING", "INSTALLED", "FAILED"].includes(String(setupState))
    || typeof setup["restartRequired"] !== "boolean"
  ) {
    return undefined;
  }
  return {
    protocolVersion: 1,
    speech,
    tts,
    python: {
      strategy: "SYSTEM_CPYTHON",
      supportedVersions: ["3.12", "3.13"]
    },
    modelSetup: {
      state: setupState as DesktopModelSetupState,
      restartRequired: setup["restartRequired"]
    }
  };
}

function parseCapability(value: unknown): DesktopRuntimeStatus["speech"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const state = record["state"];
  if (!["READY", "MISSING_ASSET", "FAILED", "UNAVAILABLE"].includes(String(state))) {
    return undefined;
  }
  const reasonCode = record["reasonCode"];
  if (reasonCode !== undefined && typeof reasonCode !== "string") return undefined;
  return {
    state: state as DesktopRuntimeCapabilityState,
    ...(reasonCode === undefined ? {} : { reasonCode })
  };
}

function modelSetupBlocked(status: DesktopRuntimeStatus | undefined): boolean {
  if (status === undefined) return false;
  return [
    status.speech.reasonCode,
    status.tts.reasonCode
  ].some((reason) =>
    reason === "WORKER_EXECUTABLE_UNAVAILABLE"
    || reason === "UNSUPPORTED_RUNTIME_PLATFORM"
  );
}

function describeVoiceRuntime(status: DesktopRuntimeStatus): string {
  if (
    status.speech.reasonCode === "WORKER_EXECUTABLE_UNAVAILABLE"
    || status.tts.reasonCode === "WORKER_EXECUTABLE_UNAVAILABLE"
  ) {
    return "Voice worker files are missing or failed integrity checks. Reinstall Interview App.";
  }
  if (
    status.speech.reasonCode === "UNSUPPORTED_RUNTIME_PLATFORM"
    || status.tts.reasonCode === "UNSUPPORTED_RUNTIME_PLATFORM"
  ) {
    return "Local voice is unavailable on this Windows architecture.";
  }
  if (status.speech.state === "READY" && status.tts.state === "READY") {
    return "Voice runtime ready.";
  }
  if (status.modelSetup.restartRequired) {
    return "Verified models installed. Restart Interview App to activate them.";
  }
  if (
    status.speech.reasonCode === "PYTHON_RUNTIME_UNAVAILABLE"
    || status.tts.reasonCode === "PYTHON_RUNTIME_UNAVAILABLE"
  ) {
    return "Voice needs a compatible system CPython 3.12 or 3.13 runtime.";
  }
  if (status.speech.state === "MISSING_ASSET" || status.tts.state === "MISSING_ASSET") {
    return "Voice models are not installed yet.";
  }
  if (status.speech.state === "FAILED" || status.tts.state === "FAILED") {
    return "Voice runtime failed validation. Check the Python prerequisite and retry after restart.";
  }
  return "Voice is unavailable; typed interviews remain fully usable.";
}


export function SettingsPage({
  connection
}: {
  readonly connection?: {
    readonly managed: boolean;
    readonly baseUrl: string;
    readonly locked: boolean;
    readonly onSaveBaseUrl: (baseUrl: string) => void;
  };
}) {
  const [draftBaseUrl, setDraftBaseUrl] = useState(connection?.baseUrl ?? "");
  const desktopRuntime = getDesktopRuntimeBridge();
  const [runtimeStatus, setRuntimeStatus] = useState<DesktopRuntimeStatus | undefined>();
  const [runtimeStatusError, setRuntimeStatusError] = useState<string | undefined>();
  const [installingModels, setInstallingModels] = useState(false);

  useEffect(() => {
    setDraftBaseUrl(connection?.baseUrl ?? "");
  }, [connection?.baseUrl]);

  useEffect(() => {
    if (desktopRuntime === undefined) return;
    let active = true;
    void desktopRuntime.getLocalRuntimeStatus()
      .then((value) => {
        if (!active) return;
        const parsed = parseDesktopRuntimeStatus(value);
        if (parsed === undefined) {
          setRuntimeStatusError("Desktop runtime status was malformed.");
          return;
        }
        setRuntimeStatus(parsed);
        setRuntimeStatusError(undefined);
      })
      .catch(() => {
        if (active) setRuntimeStatusError("Desktop runtime status is unavailable.");
      });
    return () => {
      active = false;
    };
  }, [desktopRuntime]);

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

  return (
    <div className="expressive-settings">
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
      {desktopRuntime !== undefined && (
        <section className="expressive-settings__row">
          <div className="expressive-settings__copy">
            <span>{connection === undefined ? "05" : "06"}</span>
            <div>
              <h3>Local voice runtime</h3>
              <p>
                Models stay outside the installer. Every download is verified before
                it is published to the local cache.
              </p>
            </div>
          </div>
          <div className="expressive-settings__control expressive-settings__runtime">
            <div className="expressive-settings__runtime-status" aria-live="polite">
              {runtimeStatusError
                ?? (runtimeStatus === undefined
                  ? "Checking local runtime…"
                  : describeVoiceRuntime(runtimeStatus))}
            </div>
            <div className="expressive-settings__runtime-meta">
              <span>Python: system CPython 3.12–3.13 (standard install or PATH)</span>
              <span>Typed interviews do not require Python or model files.</span>
            </div>
            <button
              type="button"
              disabled={
                installingModels
                || runtimeStatus?.modelSetup.state === "INSTALLING"
                || runtimeStatus?.modelSetup.restartRequired === true
                || modelSetupBlocked(runtimeStatus)
                || (
                  runtimeStatus?.speech.state === "READY"
                  && runtimeStatus.tts.state === "READY"
                )
              }
              onClick={() => {
                setInstallingModels(true);
                setRuntimeStatusError(undefined);
                void desktopRuntime.installLocalModels()
                  .then((value) => {
                    const parsed = parseDesktopRuntimeStatus(value);
                    if (parsed === undefined) {
                      setRuntimeStatusError("Model setup returned an invalid status.");
                      return;
                    }
                    setRuntimeStatus(parsed);
                  })
                  .catch(() => {
                    setRuntimeStatusError(
                      "Model setup failed. Check network access and disk space, then retry."
                    );
                  })
                  .finally(() => {
                    setInstallingModels(false);
                  });
              }}
            >
              {installingModels || runtimeStatus?.modelSetup.state === "INSTALLING"
                ? "Installing verified models…"
                : runtimeStatus?.modelSetup.restartRequired
                  ? "Restart to activate voice"
                  : modelSetupBlocked(runtimeStatus)
                    ? "Reinstall app to repair voice"
                    : runtimeStatus?.speech.state === "READY" && runtimeStatus.tts.state === "READY"
                      ? "Voice ready"
                      : "Install / verify voice models"}
            </button>
          </div>
        </section>
      )}

    </div>
  );
}
