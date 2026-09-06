import type { SocraticAction } from "../../domain/src/index.js";

const ZERO_DISCLOSURE_REALIZATIONS_BY_ACTION: Readonly<
  Record<SocraticAction, readonly string[]>
> = Object.freeze({
  WAIT: Object.freeze([]),
  CLARIFY: Object.freeze([
    "Can you make that step more precise?"
  ]),
  PROBE_JUSTIFICATION: Object.freeze([
    "Why must that step be true?",
    "Why must that claim hold?"
  ]),
  CHECK_LOCAL_STEP: Object.freeze([
    "Can you check that step carefully?"
  ]),
  ASK_FOR_EXAMPLE: Object.freeze([
    "Can you test your idea on a simple example?"
  ]),
  ASK_FOR_COUNTEREXAMPLE: Object.freeze([
    "Can you think of a case where that claim might fail?"
  ]),
  SIMPLIFY_CASE: Object.freeze([
    "What happens in the simplest nontrivial case?"
  ]),
  CHANGE_REPRESENTATION: Object.freeze([
    "Can you represent the same idea in a different way?"
  ]),
  FOCUS_ATTENTION: Object.freeze([
    "Which part of your argument seems most important here?"
  ]),
  RECALL_RELEVANT_FACT: Object.freeze([
    "What relevant fact might help at this point?"
  ]),
  CHALLENGE_ASSUMPTION: Object.freeze([
    "Which assumption are you using at that step?"
  ]),
  DIRECTIONAL_NUDGE: Object.freeze([
    "What feature of the problem seems most useful to exploit?"
  ]),
  EXPLICIT_HINT: Object.freeze([
    "What intermediate statement would move your argument forward?"
  ]),
  VERIFY: Object.freeze([
    "How can you verify that claim directly?"
  ]),
  GENERALIZE: Object.freeze([
    "What changes if you try to generalize your argument?"
  ]),
  ASK_ALTERNATE_SOLUTION: Object.freeze([
    "Can you find a different way to approach the same conclusion?"
  ])
});

const REVIEWED_BOARD_ANNOTATION_PURPOSES = Object.freeze([
  "Focus attention on this part of the student's work.",
  "Connect these parts of the student's work."
] as const);

export function getReviewedZeroDisclosureRealizations(
  action: SocraticAction
): readonly string[] {
  return ZERO_DISCLOSURE_REALIZATIONS_BY_ACTION[action];
}

export function getReviewedZeroDisclosureRealizationTexts(): readonly string[] {
  return Object.freeze(
    Object.values(ZERO_DISCLOSURE_REALIZATIONS_BY_ACTION).flat()
  );
}

export function getReviewedBoardAnnotationPurposes(): readonly string[] {
  return REVIEWED_BOARD_ANNOTATION_PURPOSES;
}
