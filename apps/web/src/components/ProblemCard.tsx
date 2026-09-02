import React from "react";
import type { InterviewProblemPublicView } from "../../../../packages/domain/src/index.js";
import { MathText } from "./MathText.js";
import styles from "./ProblemCard.module.css";

export interface ProblemCardProps {
  readonly problem?: InterviewProblemPublicView | null;
  readonly className?: string;
}

const ProblemCardComponent: React.FC<ProblemCardProps> = ({
  problem = null,
  className = ""
}) => {
  if (problem === null) {
    return (
      <section
        className={`${styles.problem ?? ""} ${styles.empty ?? ""} ${className}`}
        data-testid="problem-card"
        aria-label="Interview problem"
      >
        <p>No Oxford Mathematics problem is bound to this session.</p>
      </section>
    );
  }

  return (
    <section
      className={`${styles.problem ?? ""} ${className}`}
      data-testid="problem-card"
      aria-labelledby="interview-problem-title"
    >
      <header className={styles.header}>
        <h2 id="interview-problem-title" className={styles.title}>
          {problem.title}
        </h2>
        <p className={styles.summary}>
          <span>{problem.difficulty}</span>
          <span aria-hidden="true">·</span>
          <span>{problem.category}</span>
        </p>
      </header>

      <div className={styles.prompt}>
        <MathText text={problem.prompt} />
      </div>

      {problem.givenInformation.length > 0 && (
        <section className={styles.section} aria-labelledby="problem-given-heading">
          <h3 id="problem-given-heading" className={styles.sectionTitle}>
            Given
          </h3>
          <ul className={styles.givenList}>
            {problem.givenInformation.map((info, idx) => (
              <li key={idx}>
                <MathText text={info} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {problem.topics.length > 0 && (
        <div className={styles.topics} aria-label="Problem topics">
          {problem.topics.map((topic, idx) => (
            <span key={`topic-${String(idx)}`} className={styles.topic}>
              {topic}
            </span>
          ))}
        </div>
      )}
    </section>
  );
};

export const ProblemCard = React.memo(ProblemCardComponent);
ProblemCard.displayName = "ProblemCard";
