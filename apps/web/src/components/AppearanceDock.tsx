import React, { useEffect, useRef, useState } from "react";
import {
  ACCENT_OPTIONS,
  MAX_INTERFACE_ZOOM_PERCENT,
  MIN_INTERFACE_ZOOM_PERCENT,
  type ThemeMode
} from "../appearance/appearance.js";
import { useAppearance } from "../appearance/AppearanceProvider.js";
import "./AppearanceDock.css";

const THEMES: readonly ThemeMode[] = ["light", "dark"];

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
    reset
  } = useAppearance();
  const [draftZoom, setDraftZoom] = useState(settings.zoomPercent);

  useEffect(() => {
    setDraftZoom(settings.zoomPercent);
  }, [settings.zoomPercent]);

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

  const nudgeDraftZoom = (delta: number): void => {
    setDraftZoom((prev) =>
      Math.min(MAX_INTERFACE_ZOOM_PERCENT, Math.max(MIN_INTERFACE_ZOOM_PERCENT, prev + delta))
    );
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
        <span aria-hidden="true" className="appearance-dock__trigger-mark">◐</span>
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

        <section className="appearance-dock__section appearance-dock__section--last">
          <div className="appearance-zoom__heading">
            <span className="appearance-dock__label">Zoom</span>
            <button
              type="button"
              className="appearance-zoom__reset"
              onClick={() => {
                setDraftZoom(100);
                setZoomPercent(100);
              }}
              disabled={settings.zoomPercent === 100 && draftZoom === 100}
            >
              100%
            </button>
          </div>
          <div className="appearance-zoom">
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => nudgeDraftZoom(-10)}
              disabled={draftZoom <= MIN_INTERFACE_ZOOM_PERCENT}
            >
              −
            </button>
            <label className="appearance-zoom__value">
              <input
                key={draftZoom}
                type="number"
                min={MIN_INTERFACE_ZOOM_PERCENT}
                max={MAX_INTERFACE_ZOOM_PERCENT}
                step="1"
                value={draftZoom}
                aria-label="Interface zoom percent"
                onChange={(event) => {
                  const val = Number(event.currentTarget.value);
                  if (Number.isFinite(val)) setDraftZoom(val);
                }}
                onBlur={() => {
                  const normalized = Math.min(
                    MAX_INTERFACE_ZOOM_PERCENT,
                    Math.max(MIN_INTERFACE_ZOOM_PERCENT, Math.round(draftZoom))
                  );
                  setDraftZoom(normalized);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    const normalized = Math.min(
                      MAX_INTERFACE_ZOOM_PERCENT,
                      Math.max(MIN_INTERFACE_ZOOM_PERCENT, Math.round(draftZoom))
                    );
                    setDraftZoom(normalized);
                    setZoomPercent(normalized);
                  } else if (event.key === "Escape") {
                    setDraftZoom(settings.zoomPercent);
                  }
                }}
              />
              <span>%</span>
            </label>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => nudgeDraftZoom(10)}
              disabled={draftZoom >= MAX_INTERFACE_ZOOM_PERCENT}
            >
              +
            </button>
          </div>
          <button
            type="button"
            className="appearance-zoom__apply"
            onClick={() => {
              const normalized = Math.min(
                MAX_INTERFACE_ZOOM_PERCENT,
                Math.max(MIN_INTERFACE_ZOOM_PERCENT, Math.round(draftZoom))
              );
              setDraftZoom(normalized);
              setZoomPercent(normalized);
            }}
            disabled={draftZoom === settings.zoomPercent}
          >
            Apply
          </button>
        </section>
      </div>
    </details>
  );
}
