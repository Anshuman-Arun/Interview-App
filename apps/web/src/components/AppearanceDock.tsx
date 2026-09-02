import React, { useEffect, useRef } from "react";
import {
  ACCENT_OPTIONS,
  MAX_INTERFACE_ZOOM_PERCENT,
  MIN_INTERFACE_ZOOM_PERCENT,
  type BorderStyle,
  type CornerStyle,
  type ThemeMode
} from "../appearance/appearance.js";
import { useAppearance } from "../appearance/AppearanceProvider.js";
import "./AppearanceDock.css";

const THEMES: readonly ThemeMode[] = ["system", "light", "dark"];
const CORNERS: readonly CornerStyle[] = ["square", "soft", "round", "generous"];
const BORDERS: readonly BorderStyle[] = ["quiet", "regular", "strong", "contrast"];

export function AppearanceDock({
  compact = false
}: {
  readonly compact?: boolean;
}) {
  const rootRef = useRef<HTMLDetailsElement | null>(null);
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

  useEffect(() => {
    const closeFromOutside = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (
        root === null
        || !root.open
        || !(event.target instanceof Node)
        || root.contains(event.target)
      ) {
        return;
      }
      root.open = false;
    };
    const closeFromEscape = (event: KeyboardEvent): void => {
      const root = rootRef.current;
      if (event.key !== "Escape" || root === null || !root.open) return;
      root.open = false;
      root.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, []);

  const nudgeZoom = (delta: number): void => {
    setZoomPercent(settings.zoomPercent + delta);
  };

  return (
    <details
      ref={rootRef}
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
          <div className="appearance-zoom__heading">
            <span className="appearance-dock__label">Zoom</span>
            <button
              type="button"
              className="appearance-zoom__reset"
              onClick={() => setZoomPercent(100)}
              disabled={settings.zoomPercent === 100}
            >
              100%
            </button>
          </div>
          <div className="appearance-zoom">
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => nudgeZoom(-10)}
              disabled={settings.zoomPercent <= MIN_INTERFACE_ZOOM_PERCENT}
            >
              −
            </button>
            <label className="appearance-zoom__value">
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
                  setZoomPercent(next);
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
              onClick={() => nudgeZoom(10)}
              disabled={settings.zoomPercent >= MAX_INTERFACE_ZOOM_PERCENT}
            >
              +
            </button>
          </div>
          <input
            className="appearance-zoom__range"
            type="range"
            min={MIN_INTERFACE_ZOOM_PERCENT}
            max={MAX_INTERFACE_ZOOM_PERCENT}
            step="1"
            value={settings.zoomPercent}
            aria-label="Interface zoom"
            onChange={(event) => setZoomPercent(Number(event.target.value))}
          />
        </section>
      </div>
    </details>
  );
}
