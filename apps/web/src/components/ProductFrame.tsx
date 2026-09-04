import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getDesktopRuntimeBridge,
  readDesktopRuntimeStatus,
  type DesktopRuntimeStatus
} from "../desktop-runtime.js";
import { AppearanceDock } from "./AppearanceDock.js";
import { BrandMark } from "./BrandMark.js";
import "./ProductFrame.css";

export type ProductPageId = "home" | "sessions" | "settings";

function readinessLabel(ready: boolean | undefined): string {
  if (ready === undefined) return "CHECK";
  return ready ? "READY" : "SETUP";
}

export function ProductFrame({
  activePage,
  title,
  kicker,
  onNavigate,
  onNewInterview,
  reasoningReady,
  children,
  aside,
  notice,
  onDismissNotice
}: {
  readonly activePage: ProductPageId | null;
  readonly title: string;
  readonly kicker: string;
  readonly onNavigate: (page: ProductPageId) => void;
  readonly onNewInterview: () => void;
  readonly reasoningReady?: boolean;
  readonly children: ReactNode;
  readonly aside?: ReactNode;
  readonly notice?: string | null | undefined;
  readonly onDismissNotice?: (() => void) | undefined;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const desktopRuntime = useMemo(() => getDesktopRuntimeBridge(), []);
  const [runtimeStatus, setRuntimeStatus] = useState<DesktopRuntimeStatus | undefined>();

  useEffect(() => {
    headingRef.current?.focus();
  }, [title]);

  useEffect(() => {
    if (desktopRuntime === undefined) return;
    let active = true;
    void readDesktopRuntimeStatus(desktopRuntime)
      .then((status) => {
        if (active) setRuntimeStatus(status);
      })
      .catch(() => {
        if (active) setRuntimeStatus(undefined);
      });
    return () => {
      active = false;
    };
  }, [desktopRuntime]);

  const voiceReady = runtimeStatus === undefined
    ? undefined
    : runtimeStatus.speech.state === "READY" && runtimeStatus.tts.state === "READY";
  const boardReady = runtimeStatus === undefined
    ? undefined
    : runtimeStatus.vision.state === "READY";
  const allReady = voiceReady === true && boardReady === true && reasoningReady === true;

  const items: readonly { id: ProductPageId; label: string; index: string }[] = [
    { id: "home", label: "Home", index: "01" },
    { id: "sessions", label: "Sessions", index: "02" },
    { id: "settings", label: "Settings", index: "03" }
  ];

  return (
    <div className="product-frame">
      <aside className="product-frame__rail">
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
          onClick={onNewInterview}
        >
          <span>New interview</span>
          <span aria-hidden="true">↗</span>
        </button>

        <nav className="product-frame__nav" aria-label="Product navigation">
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
              onClick={() => onNavigate(item.id)}
            >
              <span className="product-frame__nav-index">{item.index}</span>
              <span className="product-frame__nav-label">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="product-frame__readiness" aria-label="Runtime readiness">
          <div className="product-frame__readiness-title">
            <i data-ready={String(allReady)} aria-hidden="true" />
            <span>{allReady ? "Ready" : "Runtime"}</span>
          </div>
          <div className="product-frame__readiness-grid">
            <span>Voice</span><b>{readinessLabel(voiceReady)}</b>
            <span>Board</span><b>{readinessLabel(boardReady)}</b>
            <span>Reasoning</span><b>{readinessLabel(reasoningReady)}</b>
          </div>
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
