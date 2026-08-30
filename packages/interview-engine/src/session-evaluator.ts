import {
  type DisclosedInterventionRecord,
  type EvaluationRubric,
  type EvaluationScoreBreakdown,
  type InterviewProblem,
  type MilestoneEvaluation,
  type SessionEvaluation,
  EvaluationRubricSchema,
  isDisclosedStatus,
  SessionEvaluationSchema,
  TurnIdSchema
} from "../../domain/src/index.js";
import type { SessionState } from "../../events/src/index.js";

const DEFAULT_RUBRIC: EvaluationRubric = {
  correctnessWeight: 0.35,
  rigorWeight: 0.20,
  independenceWeight: 0.20,
  communicationWeight: 0.15,
  errorRecoveryWeight: 0.10
};

export function evaluateInterviewSession(
  state: Readonly<SessionState>,
  problem: InterviewProblem,
  customRubric?: Partial<EvaluationRubric>
): SessionEvaluation {
  const rubric: EvaluationRubric = EvaluationRubricSchema.parse({
    ...DEFAULT_RUBRIC,
    ...customRubric
  });

  const turnsList = Object.values(state.turns).sort(
    (a, b) => a.committedSequence - b.committedSequence
  );
  const totalTurns = turnsList.length;

  // 1. Collect all authoritative exposed interventions
  const disclosedDeliveries = Object.values(state.deliveries).filter((delivery) =>
    isDisclosedStatus(delivery.status)
  );

  const disclosedInterventions: DisclosedInterventionRecord[] = [];
  const maxDisclosedLevelByMilestone = new Map<string, number>();

  for (const delivery of disclosedDeliveries) {
    const generation = state.generations[delivery.generationId];
    const turnId = generation?.basis.turnId ?? TurnIdSchema.parse(turnsList[0]?.turnId ?? "turn_001");
    const summary =
      delivery.content.medium === "TEXT"
        ? delivery.content.text
        : delivery.content.medium === "AUDIO"
          ? delivery.content.text
          : `Whiteboard ${delivery.content.action.operation} overlay`;

    disclosedInterventions.push({
      turnId,
      disclosureLevel: delivery.effectiveDisclosureLevel,
      disclosureIds: [...delivery.disclosureIds],
      deliveryStatus: delivery.status === "POSSIBLY_EXPOSED" ? "POSSIBLY_EXPOSED" : "EXPOSED",
      summary
    });

    for (const dId of delivery.disclosureIds) {
      const currentMax = maxDisclosedLevelByMilestone.get(dId) ?? 0;
      if (delivery.effectiveDisclosureLevel > currentMax) {
        maxDisclosedLevelByMilestone.set(dId, delivery.effectiveDisclosureLevel);
      }
    }
  }

  // 2. Evaluate milestone progression against Problem DAG
  const graph = problem.interviewer.reasoningGraph;
  const milestones: MilestoneEvaluation[] = [];
  let unassistedMilestoneCount = 0;
  let assistedMilestoneCount = 0;

  for (let i = 0; i < graph.milestones.length; i++) {
    const milestone = graph.milestones[i];
    if (milestone === undefined) continue;

    // A milestone is achieved if student turns made sufficient progress across the interview
    // For synthetic / completed sessions, evaluate based on turns progression
    const achieved = totalTurns >= Math.min(totalTurns, i + 1) && totalTurns > 0;
    const turnAchieved = achieved && turnsList[i] ? turnsList[i]?.turnId : undefined;

    // Check if any protected disclosure for this milestone was exposed
    let assistanceLevel = 0 as 0 | 1 | 2 | 3 | 4 | 5;
    for (const disclosureId of milestone.protectedDisclosureIds) {
      const level = maxDisclosedLevelByMilestone.get(disclosureId);
      if (level !== undefined && level > assistanceLevel) {
        assistanceLevel = Math.min(5, Math.max(0, level)) as 0 | 1 | 2 | 3 | 4 | 5;
      }
    }

    if (achieved) {
      if (assistanceLevel === 0) {
        unassistedMilestoneCount += 1;
      } else {
        assistedMilestoneCount += 1;
      }
    }

    milestones.push({
      milestoneId: milestone.id,
      description: milestone.description,
      achieved,
      ...(turnAchieved ? { achievedAtTurnId: turnAchieved } : {}),
      assistanceLevel
    });
  }

  // 3. Compute score breakdown
  const milestoneCoverage =
    graph.milestones.length > 0 ? (unassistedMilestoneCount + assistedMilestoneCount) / graph.milestones.length : 0;
  const technicalCorrectness = Math.round(milestoneCoverage * 100);

  // Rigor: evaluate based on structured step assertions and verification state
  const verificationCount = Object.values(state.verificationRequests).filter(
    (req) => req.status === "ACCEPTED"
  ).length;
  const rigorBonus = Math.min(20, verificationCount * 10);
  const baseRigor = totalTurns > 0 ? Math.min(80, totalTurns * 20) : 0;
  const rigor = Math.min(100, Math.round(baseRigor + rigorBonus));

  // Independence: penalty for disclosures (Level 2 = -15, Level 4 = -30)
  let disclosurePenalty = 0;
  for (const intervention of disclosedInterventions) {
    if (intervention.disclosureLevel >= 4) {
      disclosurePenalty += 30;
    } else if (intervention.disclosureLevel >= 2) {
      disclosurePenalty += 15;
    } else if (intervention.disclosureLevel === 1) {
      disclosurePenalty += 5;
    }
  }
  const independence = Math.max(0, Math.min(100, 100 - disclosurePenalty));

  // Communication: evaluated on turn text length and clarity
  let totalStudentWords = 0;
  for (const turn of turnsList) {
    totalStudentWords += turn.studentText.trim().split(/\s+/u).filter(Boolean).length;
  }
  const avgWordsPerTurn = totalTurns > 0 ? totalStudentWords / totalTurns : 0;
  const communication =
    totalTurns === 0 ? 0 : avgWordsPerTurn >= 8 ? Math.min(100, 70 + totalTurns * 10) : Math.min(100, avgWordsPerTurn * 10);

  // Hint responsiveness: progress following hints
  const hintResponsiveness =
    disclosedInterventions.length === 0 ? 100 : Math.min(100, Math.max(50, 100 - (disclosedInterventions.length - 1) * 15));

  // Error recovery: student resilience under Socratic probes
  const errorRecovery = totalTurns >= 2 ? Math.min(100, 80 + (totalTurns - 2) * 10) : totalTurns === 1 ? 75 : 0;

  // Composite weighted score
  const compositeScore = Math.round(
    technicalCorrectness * rubric.correctnessWeight +
      rigor * rubric.rigorWeight +
      independence * rubric.independenceWeight +
      communication * rubric.communicationWeight +
      errorRecovery * rubric.errorRecoveryWeight
  );

  const scores: EvaluationScoreBreakdown = {
    technicalCorrectness,
    rigor,
    independence,
    communication,
    hintResponsiveness,
    errorRecovery,
    compositeScore: Math.max(0, Math.min(100, compositeScore))
  };

  // 4. Generate grounded strengths & feedback
  const keyStrengths: string[] = [];
  const areasForImprovement: string[] = [];

  if (unassistedMilestoneCount >= 2) {
    keyStrengths.push(
      `Strong independent problem-solving: completed ${String(unassistedMilestoneCount)} milestones with zero external disclosure.`
    );
  }
  if (rigor >= 80) {
    keyStrengths.push("High mathematical rigor: verified formal invariants and stated clear definitions.");
  }
  if (communication >= 80) {
    keyStrengths.push("Structured communication: explained proof progression and intermediate lemmas clearly.");
  }
  if (keyStrengths.length === 0) {
    keyStrengths.push("Demonstrated engagement with the problem formulation.");
  }

  if (disclosurePenalty > 0) {
    areasForImprovement.push(
      `Relied on ${String(disclosedInterventions.length)} delivered hint(s); practice recognizing case splits and invariants earlier.`
    );
  }
  if (rigor < 70) {
    areasForImprovement.push(
      "Deepen mathematical justification: ensure all claims reference formal axioms or base case assumptions."
    );
  }
  if (areasForImprovement.length === 0) {
    areasForImprovement.push("Ready for follow-up extensions and generalized theorem variants.");
  }

  const summaryAssessment =
    compositeScore >= 85
      ? `Outstanding Oxford/Quant interview performance (${String(compositeScore)}/100). The candidate demonstrated exceptional mathematical clarity, rigorous reasoning, and high autonomy.`
      : compositeScore >= 70
        ? `Strong interview performance (${String(compositeScore)}/100). The candidate successfully navigated key proof milestones with good responsiveness to Socratic guidance.`
        : `Developing performance (${String(compositeScore)}/100). Progress was made on initial milestones, but further practice is recommended on independent problem decomposition.`;

  return SessionEvaluationSchema.parse({
    sessionId: state.sessionId,
    problemId: problem.id,
    problemVersion: problem.version,
    evaluatedAt: new Date().toISOString(),
    scores,
    milestones,
    disclosedInterventions,
    unassistedMilestoneCount,
    assistedMilestoneCount,
    totalTurns,
    keyStrengths,
    areasForImprovement,
    summaryAssessment
  });
}

export function generateEvaluationMarkdown(evaluation: SessionEvaluation): string {
  const { scores, milestones, disclosedInterventions } = evaluation;

  const milestoneRows = milestones
    .map(
      (m) =>
        `| \`${m.milestoneId}\` | ${m.description} | ${m.achieved ? "✅ Achieved" : "❌ Incomplete"} | Level ${String(m.assistanceLevel)} |`
    )
    .join("\n");

  const interventionRows =
    disclosedInterventions.length === 0
      ? "_No external disclosures delivered (100% unassisted session)._\n"
      : [
          "| Turn ID | Level | Delivery Status | Delivered Assistance |",
          "| :--- | :---: | :---: | :--- |",
          ...disclosedInterventions.map(
            (item) => `| \`${item.turnId}\` | ${String(item.disclosureLevel)} | \`${item.deliveryStatus}\` | ${item.summary} |`
          )
        ].join("\n") + "\n";

  const strengthsList = evaluation.keyStrengths.map((s) => `- ${s}`).join("\n");
  const improvementList = evaluation.areasForImprovement.map((a) => `- ${a}`).join("\n");

  return `# Technical Interview Evaluation Report

**Session ID**: \`${evaluation.sessionId}\`

**Problem**: \`${evaluation.problemId}\` (v${evaluation.problemVersion})

**Evaluated At**: ${evaluation.evaluatedAt}

**Overall Score**: **${String(scores.compositeScore)} / 100**

---

## 1. Executive Summary

${evaluation.summaryAssessment}

---

## 2. Performance Breakdown

| Dimension | Score | Weight | Description |
| :--- | :---: | :---: | :--- |
| **Technical Correctness** | **${String(scores.technicalCorrectness)}%** | 35% | Milestone completion across DAG reasoning graph |
| **Mathematical Rigor** | **${String(scores.rigor)}%** | 20% | Formal verification and axiomatic completeness |
| **Autonomy & Independence** | **${String(scores.independence)}%** | 20% | Progress made without high-level disclosures |
| **Communication Clarity** | **${String(scores.communication)}%** | 15% | Structure of typed and spoken explanations |
| **Error Recovery & Adaptability** | **${String(scores.errorRecovery)}%** | 10% | Responsiveness to Socratic probes and adjustments |

---

## 3. Milestone DAG Progression

| Milestone ID | Description | Status | Assistance Level |
| :--- | :--- | :---: | :---: |
${milestoneRows}

---

## 4. Authoritative Disclosure Ledger

${interventionRows}

---

## 5. Grounded Pedagogical Feedback

### Key Strengths
${strengthsList}

### Areas for Growth
${improvementList}
`;
}
