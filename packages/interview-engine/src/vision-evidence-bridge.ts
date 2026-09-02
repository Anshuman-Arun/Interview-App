import {
  EvidenceDimensionSchema,
  EvidenceProposalSchema,
  EvidenceRatingSchema,
  EvidenceSubjectSchema,
  VisionObservationKindSchema,
  isEvidenceValueAllowed,
  type AcceptedBoardObservation,
  type EvidenceDimension,
  type EvidenceProposal,
  type EvidenceRating,
  type EvidenceSubject,
  type EventId,
  type VisionObservationKind
} from "../../domain/src/index.js";

export interface VisionEvidenceCandidateContext {
  readonly observation: AcceptedBoardObservation;
  readonly problemId: string;
  readonly evidenceEventId: EventId;
}

export interface VisionEvidenceInterpreter {
  readonly propose: (
    context: Readonly<VisionEvidenceCandidateContext>
  ) => EvidenceProposal | undefined;
}

export interface VisionEvidenceRule {
  readonly observationKind: VisionObservationKind;
  readonly subject: EvidenceSubject;
  readonly dimension: EvidenceDimension;
  readonly proposedValue: EvidenceRating;
  readonly minConfidence?: number;
}

interface ParsedVisionEvidenceRule {
  readonly observationKind: VisionObservationKind;
  readonly subject: EvidenceSubject;
  readonly dimension: EvidenceDimension;
  readonly proposedValue: EvidenceRating;
  readonly minConfidence: number;
}

const MAX_VISION_EVIDENCE_RULES = 32;

export class RuleBasedVisionEvidenceInterpreter implements VisionEvidenceInterpreter {
  private readonly rules: ReadonlyMap<VisionObservationKind, ParsedVisionEvidenceRule>;

  public constructor(rules: readonly VisionEvidenceRule[]) {
    if (rules.length > MAX_VISION_EVIDENCE_RULES) {
      throw new RangeError("Vision evidence rule set exceeds its bounded size");
    }
    const parsed = new Map<VisionObservationKind, ParsedVisionEvidenceRule>();
    for (const rule of rules) {
      const observationKind = VisionObservationKindSchema.parse(rule.observationKind);
      if (parsed.has(observationKind)) {
        throw new Error("Vision evidence rules must be unambiguous by observation kind");
      }
      const subject = EvidenceSubjectSchema.parse(rule.subject);
      const dimension = EvidenceDimensionSchema.parse(rule.dimension);
      const proposedValue = EvidenceRatingSchema.parse(rule.proposedValue);
      const minConfidence = rule.minConfidence ?? 0.7;
      if (!Number.isFinite(minConfidence) || minConfidence < 0.7 || minConfidence > 1) {
        throw new RangeError("Vision evidence confidence threshold must be within [0.7, 1]");
      }
      if (!isEvidenceValueAllowed(
        { problemId: "validation", subject, dimension },
        proposedValue
      )) {
        throw new Error("Vision evidence rule value is invalid for its evidence dimension");
      }
      parsed.set(observationKind, {
        observationKind,
        subject,
        dimension,
        proposedValue,
        minConfidence
      });
    }
    this.rules = parsed;
  }

  public propose(
    context: Readonly<VisionEvidenceCandidateContext>
  ): EvidenceProposal | undefined {
    const rule = this.rules.get(context.observation.observationKind);
    if (
      rule === undefined
      || context.observation.observation.confidence < rule.minConfidence
    ) return undefined;

    return EvidenceProposalSchema.parse({
      key: {
        problemId: context.problemId,
        subject: rule.subject,
        dimension: rule.dimension
      },
      proposedValue: rule.proposedValue,
      inferenceConfidence: context.observation.observation.confidence,
      evidenceEventIds: [context.evidenceEventId]
    });
  }
}
