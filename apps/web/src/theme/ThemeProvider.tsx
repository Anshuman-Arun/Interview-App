import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type PropsWithChildren
} from "react";
import {
  THEME_STORAGE_KEY,
  isThemeMode,
  resolveThemeMode,
  type ResolvedTheme,
  type ThemeMode
} from "./theme.js";

interface ThemeContextValue {
  readonly mode: ThemeMode;
  readonly resolvedTheme: ResolvedTheme;
  readonly setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const initialMode = readInitialMode();
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveThemeMode(initialMode, systemPrefersDark())
  );

  const setMode = useCallback((nextMode: ThemeMode): void => {
    setModeState(nextMode);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextMode);
    } catch {
      // Theme persistence is best-effort and never interview-authoritative.
    }
  }, []);

  useLayoutEffect(() => {
    const applyResolvedTheme = (nextTheme: ResolvedTheme): void => {
      setResolvedTheme(nextTheme);
      document.documentElement.dataset["theme"] = nextTheme;
      document.documentElement.style.colorScheme = nextTheme;
    };

    if (typeof window.matchMedia !== "function") {
      applyResolvedTheme(resolveThemeMode(mode, false));
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyFromMedia = (): void => {
      applyResolvedTheme(resolveThemeMode(mode, media.matches));
    };

    applyFromMedia();
    if (mode !== "system") return;

    media.addEventListener("change", applyFromMedia);
    return () => media.removeEventListener("change", applyFromMedia);
  }, [mode]);

  const value = useMemo<ThemeContextValue>(() => ({
    mode,
    resolvedTheme,
    setMode
  }), [mode, resolvedTheme, setMode]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}

export function useTheme(): ThemeContextValue {
  const value = useOptionalTheme();
  if (value === null) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return value;
}
