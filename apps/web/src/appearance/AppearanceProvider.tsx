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
  type InterfaceScale,
  type ThemeMode
} from "./appearance.js";

interface DesktopAppearanceBridge {
  readonly setZoomFactor?: (factor: number) => void;
}

const SCALE_FACTORS: Record<InterfaceScale, number> = {
  s: 0.875,
  m: 1,
  l: 1.125,
  xl: 1.25
};

interface AppearanceContextValue {
  readonly settings: AppearanceSettings;
  readonly setTheme: (theme: ThemeMode) => void;
  readonly setAccent: (accent: AccentName) => void;
  readonly setAccentIntensity: (accentIntensity: number) => void;
  readonly setScale: (scale: InterfaceScale) => void;
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
    const root = document.documentElement;
    root.dataset["theme"] = resolveTheme(settings.theme, prefersDark);
    root.dataset["themeMode"] = settings.theme;
    root.dataset["accent"] = settings.accent;
    root.dataset["scale"] = settings.scale;
    root.dataset["corners"] = settings.corners;
    root.dataset["borders"] = settings.borders;
    root.style.setProperty("--accent-wash", `${String(settings.accentIntensity)}%`);

    const bridge = (globalThis as typeof globalThis & {
      readonly interviewDesktop?: DesktopAppearanceBridge;
    }).interviewDesktop;
    const scaleFactor = SCALE_FACTORS[settings.scale];
    if (bridge?.setZoomFactor !== undefined) {
      root.style.removeProperty("font-size");
      try {
        bridge.setZoomFactor(scaleFactor);
      } catch {
        // Desktop zoom is presentation-only. Fallback keeps browser UI usable.
        root.style.fontSize = `${String(16 * scaleFactor)}px`;
      }
    } else {
      root.style.fontSize = `${String(16 * scaleFactor)}px`;
    }

    try {
      window.localStorage.setItem(
        APPEARANCE_STORAGE_KEY,
        JSON.stringify(settings)
      );
    } catch {
      // Appearance persistence is best-effort and never session-authoritative.
    }
  }, [prefersDark, settings]);

  const patch = useCallback((next: Partial<AppearanceSettings>): void => {
    setSettings((current) => normalizeAppearance({ ...current, ...next }));
  }, []);

  const value = useMemo<AppearanceContextValue>(() => ({
    settings,
    setTheme: (theme) => patch({ theme }),
    setAccent: (accent) => patch({ accent }),
    setAccentIntensity: (accentIntensity) => patch({ accentIntensity }),
    setScale: (scale) => patch({ scale }),
    setCorners: (corners) => patch({ corners }),
    setBorders: (borders) => patch({ borders }),
    reset: () => setSettings(DEFAULT_APPEARANCE)
  }), [patch, settings]);

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
