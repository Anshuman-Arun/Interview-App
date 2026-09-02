import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  resolveTheme,
  type AccentName,
  type AppearanceSettings,
  type BorderStyle,
  type CornerStyle,
  type ResolvedTheme,
  type ThemeMode
} from "./appearance.js";

interface DesktopAppearanceBridge {
  readonly setZoomFactor?: (factor: number) => void;
  readonly onZoomFactorChanged?: (
    listener: (factor: number) => void
  ) => (() => void);
}

interface AppearanceContextValue {
  readonly settings: AppearanceSettings;
  readonly resolvedTheme: ResolvedTheme;
  readonly setTheme: (theme: ThemeMode) => void;
  readonly setAccent: (accent: AccentName) => void;
  readonly setAccentIntensity: (accentIntensity: number) => void;
  readonly setZoomPercent: (zoomPercent: number) => void;
  readonly setCorners: (corners: CornerStyle) => void;
  readonly setBorders: (borders: BorderStyle) => void;
  readonly reset: () => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function readInitialSettings(): AppearanceSettings {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return raw === null ? DEFAULT_APPEARANCE : normalizeAppearance(JSON.parse(raw));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function AppearanceProvider({
  children
}: {
  readonly children: React.ReactNode;
}) {
  const [settings, setSettings] = useState<AppearanceSettings>(readInitialSettings);
  const [prefersDark, setPrefersDark] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent): void => {
      setPrefersDark(event.matches);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const bridge = (globalThis as typeof globalThis & {
      readonly interviewDesktop?: DesktopAppearanceBridge;
    }).interviewDesktop;
    if (bridge?.onZoomFactorChanged === undefined) return;

    return bridge.onZoomFactorChanged((factor) => {
      if (!Number.isFinite(factor)) return;
      const zoomPercent = Math.round(factor * 100);
      setSettings((current) => {
        const normalized = normalizeAppearance({ ...current, zoomPercent });
        return current.zoomPercent === normalized.zoomPercent
          ? current
          : normalized;
      });
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset["theme"] = resolveTheme(settings.theme, prefersDark);
    root.dataset["themeMode"] = settings.theme;
    root.dataset["accent"] = settings.accent;
    root.dataset["zoom"] = String(settings.zoomPercent);
    root.dataset["corners"] = settings.corners;
    root.dataset["borders"] = settings.borders;
    root.style.setProperty("--accent-wash", `${String(settings.accentIntensity)}%`);

    try {
      window.localStorage.setItem(
        APPEARANCE_STORAGE_KEY,
        JSON.stringify(settings)
      );
    } catch {
      // Appearance persistence is best-effort and never session-authoritative.
    }
  }, [prefersDark, settings]);

  useEffect(() => {
    const root = document.documentElement;
    const bridge = (globalThis as typeof globalThis & {
      readonly interviewDesktop?: DesktopAppearanceBridge;
    }).interviewDesktop;
    const zoomFactor = settings.zoomPercent / 100;

    if (bridge?.setZoomFactor !== undefined) {
      root.style.removeProperty("font-size");
      try {
        bridge.setZoomFactor(zoomFactor);
        return;
      } catch {
        // Desktop zoom is presentation-only. Fallback keeps browser UI usable.
      }
    }

    root.style.fontSize = `${String(16 * zoomFactor)}px`;
  }, [settings.zoomPercent]);

  const patch = useCallback((next: Partial<AppearanceSettings>): void => {
    setSettings((current) => normalizeAppearance({ ...current, ...next }));
  }, []);

  const resolvedTheme = resolveTheme(settings.theme, prefersDark);

  const value = useMemo<AppearanceContextValue>(() => ({
    settings,
    resolvedTheme,
    setTheme: (theme) => patch({ theme }),
    setAccent: (accent) => patch({ accent }),
    setAccentIntensity: (accentIntensity) => patch({ accentIntensity }),
    setZoomPercent: (zoomPercent) => patch({ zoomPercent }),
    setCorners: (corners) => patch({ corners }),
    setBorders: (borders) => patch({ borders }),
    reset: () => setSettings(DEFAULT_APPEARANCE)
  }), [patch, resolvedTheme, settings]);

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (value === null) {
    throw new Error("useAppearance must be used inside AppearanceProvider");
  }
  return value;
}
