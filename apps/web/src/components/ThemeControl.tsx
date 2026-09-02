import React from "react";
import { useTheme } from "../theme/ThemeProvider.js";
import type { ThemeMode } from "../theme/theme.js";
import styles from "./ThemeControl.module.css";

export interface ThemeControlProps {
  readonly className?: string;
  readonly compact?: boolean;
}

const THEME_OPTIONS: readonly {
  readonly value: ThemeMode;
  readonly label: string;
}[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" }
];

export const ThemeControl: React.FC<ThemeControlProps> = ({
  className = "",
  compact = false
}) => {
  const { mode, setMode } = useTheme();

  return (
    <div
      className={`${styles.control ?? ""} ${compact ? (styles.compact ?? "") : ""} ${className}`}
      role="group"
      aria-label="Color theme"
      data-testid="theme-control"
    >
      {THEME_OPTIONS.map((option) => {
        const active = option.value === mode;
        return (
          <button
            key={option.value}
            type="button"
            className={
              active
                ? (styles.optionActive ?? "")
                : (styles.option ?? "")
            }
            aria-pressed={active}
            onClick={() => setMode(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
};
