import type {
  InterviewProblem,
  InterviewerProposal,
  RealizationRequest
} from "../../../packages/domain/src/index.js";

const RAMSEY_PROBLEM_ID = "oxford-six-people";

const CHOOSE_PERSON_REALIZATION =
  "Why must at least three edges share the same color from vertex A?";
const COMPLETE_TRIANGLE_REALIZATION =
  "Consider the three endpoints connected to vertex A by edges of the same color. What happens if any edge between them shares that color, and what happens if none of them do?";
const RAMSEY_FALLBACK_REALIZATION =
  "What relations exist between vertex A and the other five people?";

const REVIEWED_REALIZATIONS = Object.freeze([
  RAMSEY_FALLBACK_REALIZATION,
  "Why must that step be true?",
  "Why must that claim hold?",
  "Can you formalize the two cases for the edges among those three vertices?",
  CHOOSE_PERSON_REALIZATION,
  COMPLETE_TRIANGLE_REALIZATION,
  "Can you make that step more precise?",
  "What would you try next?"
] as const);

export function getReviewedProblemRealizationTexts(): readonly string[] {
  return REVIEWED_REALIZATIONS;
}

export function realizeProblemInterviewerProposal(
  problem: InterviewProblem,
  studentText: string,
  request: RealizationRequest
): InterviewerProposal {
  if (problem.id === RAMSEY_PROBLEM_ID) {
    return realizeRamseyProposal(problem, studentText, request);
  }

  const allowedDisclosureIds = new Set(request.allowedDisclosureIds ?? []);
  const authorizedDisclosure = problem.interviewer.protectedDisclosures.find(
    (disclosure) =>
      allowedDisclosureIds.has(disclosure.id)
      && disclosure.minimumDisclosureLevel <= request.maximumDisclosure
  );
  if (authorizedDisclosure !== undefined) {
    return {
      realizedAction: request.requiredAction,
      claimedDisclosureLevel: authorizedDisclosure.minimumDisclosureLevel,
      claimedDisclosureIds: [authorizedDisclosure.id],
      speechText: authorizedDisclosure.fact
    };
  }

  return {
    realizedAction: request.requiredAction,
    claimedDisclosureLevel: 0,
    claimedDisclosureIds: [],
    speechText: "Why must that step be true?"
  };
}

function realizeRamseyProposal(
  problem: InterviewProblem,
  studentText: string,
  request: RealizationRequest
): InterviewerProposal {
  const text = studentText.toLowerCase();
  const allowedDisclosureIds = new Set(request.allowedDisclosureIds ?? []);

  const completeTriangle = problem.interviewer.protectedDisclosures[1];
  if (
    request.maximumDisclosure >= 4
    && completeTriangle !== undefined
    && allowedDisclosureIds.has(completeTriangle.id)
    && (
      text.includes("pigeonhole")
      || text.includes("3")
      || text.includes("three")
      || text.includes("same color")
      || text.includes("same colour")
    )
  ) {
    return {
      realizedAction: request.requiredAction,
      claimedDisclosureLevel: 4,
      claimedDisclosureIds: [completeTriangle.id],
      speechText: COMPLETE_TRIANGLE_REALIZATION
    };
  }

  const choosePerson = problem.interviewer.protectedDisclosures[0];
  if (
    request.maximumDisclosure >= 2
    && choosePerson !== undefined
    && allowedDisclosureIds.has(choosePerson.id)
  ) {
    return {
      realizedAction: request.requiredAction,
      claimedDisclosureLevel: 2,
      claimedDisclosureIds: [choosePerson.id],
      speechText: CHOOSE_PERSON_REALIZATION
    };
  }

  return {
    realizedAction: request.requiredAction,
    claimedDisclosureLevel: 0,
    claimedDisclosureIds: [],
    speechText: RAMSEY_FALLBACK_REALIZATION
  };
}
