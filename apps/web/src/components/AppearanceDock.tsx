import {
  ACCENT_OPTIONS,
  type BorderStyle,
  type CornerStyle,
  type InterfaceScale,
  type ThemeMode
} from "../appearance/appearance.js";
import { useAppearance } from "../appearance/AppearanceProvider.js";
import "./AppearanceDock.css";

const THEMES: readonly ThemeMode[] = ["system", "light", "dark"];
const SCALES: readonly InterfaceScale[] = ["s", "m", "l", "xl"];
const CORNERS: readonly CornerStyle[] = ["square", "soft", "round", "generous"];
const BORDERS: readonly BorderStyle[] = ["quiet", "regular", "strong", "contrast"];

export function AppearanceDock({
  compact = false
}: {
  readonly compact?: boolean;
}) {
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

  return (
    <details
      className={
        compact
          ? "appearance-dock appearance-dock--compact"
          : "appearance-dock"
      }
    >
      <summary className="appearance-dock__trigger" aria-label="Appearance settings">
        <span aria-hidden="true" className="appearance-dock__trigger-mark">Aa</span>
        {!compact && <span>Appearance</span>}
      </summary>

      <div className="appearance-dock__panel">
        <div className="appearance-dock__header">
          <div>
            <strong>Appearance</strong>
            <span>Local interface only</span>
          </div>
          <button type="button" onClick={reset}>Reset</button>
        </div>

        <section className="appearance-dock__section">
          <span className="appearance-dock__label">Theme</span>
          <div className="appearance-segment">
            {THEMES.map((theme) => (
              <button
                key={theme}
                type="button"
                aria-pressed={settings.theme === theme}
                onClick={() => setTheme(theme)}
              >
                {theme.charAt(0).toUpperCase() + theme.slice(1)}
              </button>
            ))}
          </div>
        </section>

        <section className="appearance-dock__section">
          <span className="appearance-dock__label">Accent</span>
          <div className="appearance-swatches">
            {ACCENT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-label={option.label}
                aria-pressed={settings.accent === option.id}
                className="appearance-swatch"
                style={{ "--swatch": option.color } as React.CSSProperties}
                onClick={() => setAccent(option.id)}
              />
            ))}
          </div>
          <label className="appearance-slider">
            <span>Accent intensity</span>
            <input
              type="range"
              min="8"
              max="28"
              step="1"
              value={settings.accentIntensity}
              onChange={(event) => {
                setAccentIntensity(Number(event.target.value));
              }}
            />
          </label>
        </section>

        <section className="appearance-dock__section">
          <span className="appearance-dock__label">Corners</span>
          <div className="appearance-icon-options">
            {CORNERS.map((corner, index) => (
              <button
                key={corner}
                type="button"
                aria-label={corner}
                aria-pressed={settings.corners === corner}
                onClick={() => setCorners(corner)}
              >
                <span
                  className="appearance-corner-sample"
                  data-corner={corner}
                  aria-hidden="true"
                />
                <small>{index + 1}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="appearance-dock__section">
          <span className="appearance-dock__label">Borders</span>
          <div className="appearance-icon-options">
            {BORDERS.map((border) => (
              <button
                key={border}
                type="button"
                aria-label={border}
                aria-pressed={settings.borders === border}
                onClick={() => setBorders(border)}
              >
                <span
                  className="appearance-border-sample"
                  data-border={border}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        </section>

        <section className="appearance-dock__section appearance-dock__section--last">
          <span className="appearance-dock__label">Interface scale</span>
          <div className="appearance-scale-options">
            {SCALES.map((scale) => (
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
      </div>
    </details>
  );
}
