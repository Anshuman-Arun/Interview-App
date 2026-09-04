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
  navigationLocked = false
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
  readonly navigationLocked?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [title]);

  const items: readonly { id: ProductPageId; label: string; index: string }[] = [
    { id: "home", label: "Home", index: "01" },
    { id: "sessions", label: "Sessions", index: "02" },
    { id: "settings", label: "Settings", index: "03" }
  ];

  return (
    <div className="product-frame">
      <aside className="product-frame__rail" data-product-rail>
        <button
          type="button"
          className="product-frame__brand"
          onClick={() => onNavigate("home")}
          aria-label="Open Home"
        >
          <BrandMark size={24} title="Interview" />
          <span>Interview</span>
        </button>

        <button
          type="button"
          className="product-frame__new"
          onClick={() => onNavigate("new")}
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
              disabled={navigationLocked && item.id !== "home"}
              title={
                navigationLocked && item.id !== "home"
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

        <div className="product-frame__rail-note" aria-label="Local readiness">
          <span className="product-frame__readiness-title">
            <i
              data-ready={String(reasoningReady)}
              data-checking={String(reasoningChecking)}
              aria-hidden="true"
            />
            {reasoningChecking ? "Checking" : reasoningReady ? "Ready" : "Setup needed"}
          </span>
          <span className="product-frame__readiness-row"><span>Voice</span><b>LOCAL</b></span>
          <span className="product-frame__readiness-row"><span>Board</span><b>LOCAL</b></span>
          <span className="product-frame__readiness-row">
            <span>Reasoning</span>
            <b>{reasoningChecking ? "CHECKING" : reasoningReady ? "READY" : "SETUP"}</b>
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
              data-ready={String(reasoningReady)}
              data-checking={String(reasoningChecking)}
            >
              <i aria-hidden="true" />
              {reasoningChecking ? "CHECKING" : reasoningReady ? "READY" : "CHECK SETUP"}
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
