import { useEffect, useRef, type ReactNode } from "react";
import { AppearanceDock } from "./AppearanceDock.js";
import { BrandMark } from "./BrandMark.js";
import "./ProductFrame.css";

export type ProductPageId = "home" | "new" | "sessions" | "settings";

export function ProductFrame({
  activePage,
  title,
  kicker,
  onNavigate,
  children,
  aside,
  notice,
  onDismissNotice,
  reasoningReady = true,
  reasoningChecking = false,
  authorityChecking = false,
  authorityUnavailable = false,
  navigationLocked = false,
  transitionLocked = false
}: {
  readonly activePage: ProductPageId | null;
  readonly title: string;
  readonly kicker: string;
  readonly onNavigate: (page: ProductPageId) => void;
  readonly children: ReactNode;
  readonly aside?: ReactNode;
  readonly notice?: string | null | undefined;
  readonly onDismissNotice?: (() => void) | undefined;
  readonly reasoningReady?: boolean;
  readonly reasoningChecking?: boolean;
  readonly authorityChecking?: boolean;
  readonly authorityUnavailable?: boolean;
  readonly navigationLocked?: boolean;
  readonly transitionLocked?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [title]);

  const readinessChecking = reasoningChecking || authorityChecking;
  const readinessReady =
    reasoningReady && !authorityChecking && !authorityUnavailable;
  const readinessLabel = readinessChecking
    ? "Checking"
    : authorityUnavailable
      ? "Session check needed"
      : reasoningReady
        ? "Ready"
        : "Setup needed";

  const items: readonly { id: ProductPageId; label: string; index: string }[] = [
    { id: "home", label: "Home", index: "01" },
    { id: "sessions", label: "Sessions", index: "02" },
    { id: "settings", label: "Settings", index: "03" }
  ];

  return (
    <div className="product-frame" aria-busy={transitionLocked}>
      <aside className="product-frame__rail" data-product-rail>
        <button
          type="button"
          className="product-frame__brand"
          onClick={() => onNavigate("home")}
          disabled={transitionLocked}
          title={transitionLocked ? "Session transition in progress." : undefined}
          aria-label="Open Home"
        >
          <BrandMark size={24} title="Interview" />
          <span>Interview</span>
        </button>

        <button
          type="button"
          className="product-frame__new"
          onClick={() => onNavigate("new")}
          disabled={transitionLocked || navigationLocked}
          title={
            transitionLocked
              ? "Session transition in progress."
              : navigationLocked
                ? "Resume or finish the paused interview before starting a new interview."
                : undefined
          }
        >
          <span>New interview</span>
          <span aria-hidden="true">↗</span>
        </button>

        <nav className="product-frame__nav" aria-label="Product navigation">
          <span className="product-frame__nav-label">Navigation</span>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                activePage === item.id
                  ? "product-frame__nav-item product-frame__nav-item--active"
                  : "product-frame__nav-item"
              }
              aria-current={activePage === item.id ? "page" : undefined}
              disabled={
                transitionLocked
                || (navigationLocked && item.id !== "home")
              }
              title={
                transitionLocked
                  ? "Session transition in progress."
                  : navigationLocked && item.id !== "home"
                    ? "Resume or finish the paused interview before opening this page."
                    : undefined
              }
              onClick={() => onNavigate(item.id)}
            >
              <span className="product-frame__nav-index">{item.index}</span>
              <span className="product-frame__nav-copy">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="product-frame__rail-note" aria-label="Interview readiness">
          <span className="product-frame__readiness-title">
            <i
              data-ready={String(readinessReady)}
              data-checking={String(readinessChecking)}
              aria-hidden="true"
            />
            {readinessLabel}
          </span>
          <span className="product-frame__readiness-row"><span>Voice</span><b>LOCAL</b></span>
          <span className="product-frame__readiness-row"><span>Board</span><b>LOCAL</b></span>
          <span className="product-frame__readiness-row">
            <span>Reasoning</span>
            <b>{reasoningChecking ? "CHECKING" : reasoningReady ? "READY" : "SETUP"}</b>
          </span>
          <span className="product-frame__readiness-row">
            <span>Sessions</span>
            <b>{authorityChecking ? "CHECKING" : authorityUnavailable ? "RETRY" : "VERIFIED"}</b>
          </span>
          <span className="product-frame__rail-rule" aria-hidden="true" />
          <span className="product-frame__readiness-foot">VOICE · BOARD · REPLAY</span>
        </div>
      </aside>

      <div className="product-frame__main">
        <header className="product-frame__header">
          <div>
            {kicker.length > 0 && <span className="product-frame__kicker">{kicker}</span>}
            <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
          </div>
          <div className="product-frame__header-actions">
            {aside}
            <span
              className="product-frame__status-chip"
              data-ready={String(readinessReady)}
              data-checking={String(readinessChecking)}
            >
              <i aria-hidden="true" />
              {readinessChecking ? "CHECKING" : readinessReady ? "READY" : authorityUnavailable ? "CHECK SESSIONS" : "CHECK SETUP"}
            </span>
            <AppearanceDock />
          </div>
        </header>
        {notice !== undefined && notice !== null && (
          <div className="product-frame__notice" role="status">
            <span>NOTICE</span>
            <p>{notice}</p>
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
        <main className="product-frame__content">{children}</main>
      </div>
    </div>
  );
}
