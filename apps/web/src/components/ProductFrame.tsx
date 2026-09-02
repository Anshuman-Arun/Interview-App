import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark.js";
import "./ProductFrame.css";

export type ProductPageId = "home" | "sessions" | "settings";

export function ProductFrame({
  activePage,
  title,
  kicker,
  onNavigate,
  children,
  aside,
  notice,
  onDismissNotice
}: {
  readonly activePage: ProductPageId | null;
  readonly title: string;
  readonly kicker: string;
  readonly onNavigate: (page: ProductPageId) => void;
  readonly children: ReactNode;
  readonly aside?: ReactNode;
  readonly notice?: string | null;
  readonly onDismissNotice?: (() => void) | undefined;
}) {
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
          <BrandMark size={27} title="Interview" />
          <span>Interview</span>
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
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="product-frame__rail-note">
          <span>LOCAL</span>
          <span aria-hidden="true" className="product-frame__rail-rule" />
          <span>VOICE · BOARD · REPLAY</span>
        </div>
      </aside>

      <div className="product-frame__main">
        <header className="product-frame__header">
          <div>
            <span className="product-frame__kicker">{kicker}</span>
            <h1>{title}</h1>
          </div>
          {aside}
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
