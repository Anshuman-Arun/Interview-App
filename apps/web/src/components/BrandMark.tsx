import React from "react";
import styles from "./BrandMark.module.css";

export interface BrandMarkProps {
  readonly size?: number;
  readonly className?: string;
  readonly title?: string;
}

export const BrandMark: React.FC<BrandMarkProps> = ({
  size = 24,
  className = "",
  title
}) => {
  const labelled = title !== undefined;

  return (
    <svg
      className={`${styles.mark ?? ""} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={labelled ? "img" : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      data-testid="brand-mark"
    >
      {labelled && <title>{title}</title>}
      <path
        className={styles.frame}
        d="M9 5.25H7.25A2 2 0 0 0 5.25 7.25v9.5a2 2 0 0 0 2 2H9"
      />
      <path
        className={styles.frame}
        d="M15 5.25h1.75a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H15"
      />
      <path
        className={styles.core}
        d="M10.25 8h3.5M12 8v8m-1.75 0h3.5"
      />
    </svg>
  );
};
