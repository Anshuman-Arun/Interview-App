import { useEffect, useState } from "react";
import type {
  BorderStyle,
  CornerStyle,
  InterfaceScale,
  ThemeMode
} from "../appearance/appearance.js";
import { ACCENT_OPTIONS } from "../appearance/appearance.js";
import { useAppearance } from "../appearance/AppearanceProvider.js";
import "./SettingsPage.css";

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

  useEffect(() => {
    setDraftBaseUrl(connection?.baseUrl ?? "");
  }, [connection?.baseUrl]);

  const {
    settings,
    setTheme,
    setAccent,
    setAccentIntensity,
    setScale,
    setCorners,
    setBorders,
    reset
  } = useAppearance();

  const themes: readonly ThemeMode[] = ["system", "light", "dark"];
  const scales: readonly InterfaceScale[] = ["s", "m", "l", "xl"];
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
            <h3>Interface scale</h3>
            <p>This is the native whole-app zoom control: S, M, L, or XL.</p>
          </div>
        </div>
        <div className="expressive-settings__control expressive-settings__scale">
          {scales.map((scale) => (
            <button
              key={scale}
              type="button"
              aria-pressed={settings.scale === scale}
              onClick={() => setScale(scale)}
            >
              {scale.toUpperCase()}
            </button>
          ))}
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
