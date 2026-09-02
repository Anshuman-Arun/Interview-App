export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type AccentName =
  | "ink"
  | "cobalt"
  | "teal"
  | "amber"
  | "coral"
  | "violet"
  | "rose";
export type InterfaceScale = "s" | "m" | "l" | "xl";
export type CornerStyle = "square" | "soft" | "round" | "generous";
export type BorderStyle = "quiet" | "regular" | "strong" | "contrast";

export interface AppearanceSettings {
  readonly theme: ThemeMode;
  readonly accent: AccentName;
  readonly accentIntensity: number;
  readonly scale: InterfaceScale;
  readonly corners: CornerStyle;
  readonly borders: BorderStyle;
}

export const APPEARANCE_STORAGE_KEY = "interview-appearance-v1";

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "system",
  accent: "cobalt",
  accentIntensity: 16,
  scale: "m",
  corners: "soft",
  borders: "regular"
};

export const ACCENT_OPTIONS: readonly {
  readonly id: AccentName;
  readonly label: string;
  readonly color: string;
}[] = [
  { id: "ink", label: "Ink", color: "#24272e" },
  { id: "cobalt", label: "Cobalt", color: "#315ee8" },
  { id: "teal", label: "Teal", color: "#078d83" },
  { id: "amber", label: "Amber", color: "#d98616" },
  { id: "coral", label: "Coral", color: "#dd6048" },
  { id: "violet", label: "Violet", color: "#7755d9" },
  { id: "rose", label: "Rose", color: "#c84e72" }
];

const THEMES = new Set<ThemeMode>(["system", "light", "dark"]);
const ACCENTS = new Set<AccentName>(ACCENT_OPTIONS.map((item) => item.id));
const SCALES = new Set<InterfaceScale>(["s", "m", "l", "xl"]);
const CORNERS = new Set<CornerStyle>(["square", "soft", "round", "generous"]);
const BORDERS = new Set<BorderStyle>(["quiet", "regular", "strong", "contrast"]);

export function normalizeAppearance(value: unknown): AppearanceSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_APPEARANCE;
  const candidate = value as Partial<AppearanceSettings>;
  return {
    theme: THEMES.has(candidate.theme as ThemeMode)
      ? candidate.theme as ThemeMode
      : DEFAULT_APPEARANCE.theme,
    accent: ACCENTS.has(candidate.accent as AccentName)
      ? candidate.accent as AccentName
      : DEFAULT_APPEARANCE.accent,
    accentIntensity:
      typeof candidate.accentIntensity === "number"
      && Number.isFinite(candidate.accentIntensity)
        ? Math.min(28, Math.max(8, Math.round(candidate.accentIntensity)))
        : DEFAULT_APPEARANCE.accentIntensity,
    scale: SCALES.has(candidate.scale as InterfaceScale)
      ? candidate.scale as InterfaceScale
      : DEFAULT_APPEARANCE.scale,
    corners: CORNERS.has(candidate.corners as CornerStyle)
      ? candidate.corners as CornerStyle
      : DEFAULT_APPEARANCE.corners,
    borders: BORDERS.has(candidate.borders as BorderStyle)
      ? candidate.borders as BorderStyle
      : DEFAULT_APPEARANCE.borders
  };
}

export function resolveTheme(
  mode: ThemeMode,
  prefersDark: boolean
): ResolvedTheme {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}
