import React, { useEffect, useRef } from "react";
import { BrandMark } from "./BrandMark.js";
import styles from "./AppPageFrame.module.css";

export type ProductNavPage = "home" | "sessions" | "settings";

export interface AppPageFrameProps {
  readonly activePage: ProductNavPage | null;
  readonly title: string;
  readonly description?: string;
  readonly activeInterviewLabel?: string | null;
  readonly onNavigate: (page: ProductNavPage) => void;
  readonly onResumeInterview?: (() => void) | undefined;
  readonly children: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly notice?: string | null;
  readonly onDismissNotice?: (() => void) | undefined;
}

const NAV_ITEMS: readonly {
  readonly page: ProductNavPage;
  readonly label: string;
}[] = [
  { page: "home", label: "Home" },
  { page: "sessions", label: "Sessions" },
  { page: "settings", label: "Settings" }
];

export const AppPageFrame: React.FC<AppPageFrameProps> = ({
  activePage,
  title,
  description,
  activeInterviewLabel = null,
  onNavigate,
  onResumeInterview,
  children,
  actions,
  notice = null,
  onDismissNotice
}) => {
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [title]);

  return (
    <div className={styles.frame ?? ""}>
      <aside className={styles.sidebar}>
        <button
          type="button"
          className={styles.brand}
          onClick={() => onNavigate("home")}
          aria-label="Go to home"
        >
          <BrandMark size={24} />
          <span>Interview</span>
        </button>

        <nav className={styles.nav} aria-label="Application">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.page}
              type="button"
              aria-current={activePage === item.page ? "page" : undefined}
              className={
                activePage === item.page
                  ? (styles.navItemActive ?? "")
                  : (styles.navItem ?? "")
              }
              onClick={() => onNavigate(item.page)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {activeInterviewLabel !== null && onResumeInterview !== undefined && (
          <div className={styles.activeInterview}>
            <span className={styles.activeDot} aria-hidden="true" />
            <div>
              <span className={styles.activeLabel}>Active interview</span>
              <strong>{activeInterviewLabel}</strong>
            </div>
            <button type="button" onClick={onResumeInterview}>
              Resume
            </button>
          </div>
        )}
      </aside>

      <div className={styles.main}>
        <header className={styles.pageHeader}>
          <div className={styles.pageTitleBlock}>
            <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
            {description !== undefined && <p>{description}</p>}
          </div>
          {actions !== undefined && (
            <div className={styles.pageActions}>{actions}</div>
          )}
        </header>

        {notice !== null && (
          <div className={styles.notice} role="status">
            <span className={styles.noticeLabel}>Notice</span>
            <span className={styles.noticeText}>{notice}</span>
            {onDismissNotice !== undefined && (
              <button
                type="button"
                onClick={onDismissNotice}
                aria-label="Dismiss notice"
              >
                ×
              </button>
            )}
          </div>
        )}

        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
};
