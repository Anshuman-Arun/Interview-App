import { useEffect, useRef } from "react";
import type {
  SessionId,
  StoredSessionSummary
} from "../../../../packages/domain/src/index.js";
import "./HomePage.css";

export function HomePage({
  activeSessionId,
  activeProblemTitle,
  activeSessionPaused,
  sessions,
  onStartInterview,
  onResumeInterview,
  onOpenSessions,
  onOpenSettings,
  canReview,
  onReview,
  sessionEntryPending
}: {
  readonly activeSessionId: SessionId | null;
  readonly activeProblemTitle?: string | null;
  readonly activeSessionPaused?: boolean;
  readonly sessions: readonly StoredSessionSummary[];
  readonly onStartInterview: () => void;
  readonly onResumeInterview: (sessionId: SessionId) => void;
  readonly onOpenSessions: () => void;
  readonly onOpenSettings: () => void;
  readonly canReview: (session: StoredSessionSummary) => boolean;
  readonly onReview: (sessionId: SessionId) => void;
  readonly sessionEntryPending: boolean;
}) {
  const heroRef = useRef<HTMLElement | null>(null);
  const heroCopyRef = useRef<HTMLDivElement | null>(null);
  const folioRef = useRef<HTMLDivElement | null>(null);
  const recent = [...sessions]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 5);

  useEffect(() => {
    const hero = heroRef.current;
    const copy = heroCopyRef.current;
    const folio = folioRef.current;
    const sidebar = document.querySelector<HTMLElement>(".product-frame__rail");
    if (hero === null || copy === null || folio === null || sidebar === null) return;

    let firstFrame = 0;
    let secondFrame = 0;

    const correctMidpoint = (): void => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      firstFrame = requestAnimationFrame(() => {
        if (window.matchMedia("(max-width: 1060px)").matches) {
          hero.style.setProperty("--home-midpoint-shift", "0px");
          return;
        }

        hero.style.setProperty("--home-midpoint-shift", "0px");
        secondFrame = requestAnimationFrame(() => {
          const sidebarRect = sidebar.getBoundingClientRect();
          const folioRect = folio.getBoundingClientRect();
          const copyRect = copy.getBoundingClientRect();
          const target = (sidebarRect.right + folioRect.left) / 2;
          const center = (copyRect.left + copyRect.right) / 2;
          hero.style.setProperty("--home-midpoint-shift", `${(target - center).toFixed(3)}px`);
        });
      });
    };

    const observer = new ResizeObserver(correctMidpoint);
    observer.observe(hero);
    observer.observe(copy);
    observer.observe(folio);
    observer.observe(sidebar);
    window.addEventListener("resize", correctMidpoint, { passive: true });
    void document.fonts?.ready.then(correctMidpoint).catch(() => undefined);
    correctMidpoint();

    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      observer.disconnect();
      window.removeEventListener("resize", correctMidpoint);
    };
  }, []);

  return (
    <div className="expressive-home">
      <section className="expressive-home__hero" ref={heroRef}>
        <div className="expressive-home__marginalia" aria-hidden="true">
          <svg viewBox="0 0 1500 650" preserveAspectRatio="none">
            <path className="expressive-home__pencil" d="M1110 96 q58 8 94 47" />
            <path className="expressive-home__pencil" d="M1218 150 l74 -42" />
            <path className="expressive-home__pencil" d="M1084 356 q38 -44 87 -55" />
            <path className="expressive-home__pencil expressive-home__pencil--dashed" d="M1170 303 l87 76" />
            <path className="expressive-home__pencil" d="M1320 250 l42 0" />
            <path className="expressive-home__pencil" d="M1341 229 l0 42" />
            <circle className="expressive-home__red-dot" cx="1248" cy="180" r="4" />
            <circle className="expressive-home__pencil-circle" cx="1248" cy="180" r="19" />
            <text className="expressive-home__mini-label" x="1272" y="174">P</text>
          </svg>
        </div>

        <div className="expressive-home__hero-copy" ref={heroCopyRef}>
          <div className="expressive-home__overline">
            Oxford Mathematics · Quant Trading · Quant Research
          </div>
          <h2 className="expressive-home__title">
            Think aloud.
            <em>Draw it out.</em>
          </h2>
          <p className="expressive-home__dek">
            Voice, whiteboard, and a demanding interviewer.
          </p>
          <div className="expressive-home__hero-actions">
            {activeSessionId === null ? (
              <button
                type="button"
                className="expressive-home__primary"
                onClick={onStartInterview}
                disabled={sessionEntryPending}
                data-testid="start-session-btn"
              >
                <span>{sessionEntryPending ? "Opening room…" : "New interview"}</span>
                <i aria-hidden="true">→</i>
              </button>
            ) : (
              <button
                type="button"
                className="expressive-home__primary"
                onClick={() => onResumeInterview(activeSessionId)}
                disabled={sessionEntryPending}
              >
                <span>
                  {sessionEntryPending
                    ? "Opening room…"
                    : activeSessionPaused
                      ? "Resume interview"
                      : "Return to room"}
                </span>
                <i aria-hidden="true">→</i>
              </button>
            )}
            <button type="button" className="expressive-home__secondary" onClick={onOpenSessions}>
              Sessions
            </button>
          </div>
        </div>

        <div
          className="expressive-home__folio"
          ref={folioRef}
          aria-label="Example Oxford mathematics board"
        >
          <article className="expressive-home__folio-sheet">
            <div className="expressive-home__folio-head">
              <span>Oxford Mathematics</span>
              <span>Interview folio</span>
            </div>
            <div className="expressive-home__folio-board">
              <svg viewBox="0 0 520 470" aria-hidden="true">
                <defs>
                  <linearGradient id="home-sub-tri-a" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="var(--accent)" stopOpacity=".075" />
                    <stop offset="1" stopColor="var(--accent)" stopOpacity=".02" />
                  </linearGradient>
                  <linearGradient id="home-sub-tri-b" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="var(--info)" stopOpacity=".065" />
                    <stop offset="1" stopColor="var(--info)" stopOpacity=".018" />
                  </linearGradient>
                </defs>
                <polygon points="260,70 100,390 275,255" fill="url(#home-sub-tri-a)" />
                <polygon points="260,70 420,390 275,255" fill="url(#home-sub-tri-b)" />
                <polygon points="100,390 420,390 275,255" fill="var(--accent)" opacity=".025" />
                <path className="expressive-home__sketch" d="M260 70 L100 390 L420 390 Z" />
                <path className="expressive-home__sketch expressive-home__sketch--accent" d="M275 255 L189 212" />
                <path className="expressive-home__sketch expressive-home__sketch--accent" d="M275 255 L337 224" />
                <path className="expressive-home__sketch expressive-home__sketch--accent" d="M275 255 L275 390" />
                <path className="expressive-home__sketch expressive-home__sketch--faint" d="M189 212 l7 3.5 l3.5 -7" />
                <path className="expressive-home__sketch expressive-home__sketch--faint" d="M337 224 l-7 3.5 l-3.5 -7" />
                <path className="expressive-home__sketch expressive-home__sketch--faint" d="M275 390 l0 -11 l11 0" />
                <circle cx="275" cy="255" r="5.5" fill="var(--accent)" />
                <circle cx="189" cy="212" r="2.6" fill="var(--accent)" opacity=".8" />
                <circle cx="337" cy="224" r="2.6" fill="var(--accent)" opacity=".8" />
                <circle cx="275" cy="390" r="2.6" fill="var(--accent)" opacity=".8" />
                <text x="250" y="52" className="expressive-home__folio-label">A</text>
                <text x="77" y="413" className="expressive-home__folio-label">B</text>
                <text x="429" y="413" className="expressive-home__folio-label">C</text>
                <text x="286" y="250" className="expressive-home__folio-label expressive-home__folio-label--p">P</text>
              </svg>
            </div>
            <div className="expressive-home__folio-cap">
              <strong>Triangle distances</strong>
              <span>THINK · DRAW<br />EXPLAIN</span>
            </div>
          </article>
        </div>
      </section>

      {activeSessionId !== null && (
        <section className="expressive-home__active">
          <span>NOW</span>
          <div>
            <strong>{activeProblemTitle ?? "Interview in progress"}</strong>
            <p>
              {activeSessionPaused
                ? "Paused without ending the authoritative session."
                : "An active room already exists."}
            </p>
          </div>
          <button
            type="button"
            disabled={sessionEntryPending}
            onClick={() => onResumeInterview(activeSessionId)}
          >
            {sessionEntryPending ? "Opening…" : "Resume →"}
          </button>
        </section>
      )}

      <section className="expressive-home__modes">
        <header>
          <h3>Practice rooms</h3>
        </header>
        <div className="expressive-home__mode-grid">
          <article>
            <span>01 · SOCRATIC + BOARD</span>
            <h4>Oxford Mathematics</h4>
            <p>Proofs, exploration, and explanation with voice and tldraw.</p>
            <footer><span>VOICE · BOARD</span><span>45–60 MIN</span></footer>
          </article>
          <article>
            <span>02 · MARKET MAKING</span>
            <h4>Quant Trading</h4>
            <p>Quotes, fills, inventory, P&amp;L, and risk.</p>
            <footer><span>STRUCTURED</span><span>ROUNDS</span></footer>
          </article>
          <article>
            <span>03 · RESEARCH</span>
            <h4>Quant Research</h4>
            <p>Bayes, sampling, estimation, and experimental design.</p>
            <footer><span>STRUCTURED</span><span>SCENARIOS</span></footer>
          </article>
        </div>
      </section>

      <section className="expressive-home__recent">
        <header>
          <h3>Recent sessions</h3>
          <button type="button" onClick={onOpenSessions}>See all →</button>
        </header>

        {recent.length === 0 ? (
          <div className="expressive-home__empty">
            Your first completed interview will leave a trail here.
          </div>
        ) : (
          <div className="expressive-home__rows">
            {recent.map((session, index) => {
              const reviewable = canReview(session);
              return (
                <article key={session.sessionId} className="expressive-home__row">
                  <span className="expressive-home__row-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="expressive-home__row-main">
                    <strong>
                      {session.status === "ACTIVE"
                        ? "Active interview"
                        : session.problemId ?? "Configured interview"}
                    </strong>
                    <code>{session.sessionId}</code>
                  </div>
                  <span className="expressive-home__row-status" data-status={session.status}>
                    {session.status.toLowerCase()}
                  </span>
                  <time dateTime={session.updatedAt}>
                    {new Date(session.updatedAt).toLocaleDateString([], {
                      month: "short",
                      day: "numeric"
                    })}
                  </time>
                  <button
                    type="button"
                    disabled={session.status !== "ACTIVE" && !reviewable}
                    onClick={
                      session.status === "ACTIVE"
                        ? () => onResumeInterview(session.sessionId)
                        : reviewable
                          ? () => onReview(session.sessionId)
                          : undefined
                    }
                  >
                    {session.status === "ACTIVE" ? "Resume" : reviewable ? "Review" : "—"}
                  </button>
                </article>
              );
            })}
          </div>
        )}

        <button type="button" className="expressive-home__settings-link" onClick={onOpenSettings}>
          Tune the room
        </button>
      </section>
    </div>
  );
}
