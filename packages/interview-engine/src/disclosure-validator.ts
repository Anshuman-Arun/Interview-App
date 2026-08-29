import type {
  DisclosureAnalysis,
  DisclosureId,
  DisclosureLevel,
  InterviewerProposal,
  ProtectedDisclosure,
  RealizationRequest
} from "../../domain/src/index.js";

export interface DisclosureAnalyzer {
  readonly analyze: (text: string, protectedDisclosures: readonly ProtectedDisclosure[]) => DisclosureAnalysis;
}

const normalize = (text: string): string => text.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();

export class ClosedWorldDisclosureAnalyzer implements DisclosureAnalyzer {
  private readonly safeTexts: ReadonlySet<string>;

  public constructor(safeTexts: readonly string[]) {
    this.safeTexts = new Set(safeTexts.map(normalize));
  }

  public analyze(text: string, protectedDisclosures: readonly ProtectedDisclosure[]): DisclosureAnalysis {
    const normalized = normalize(text);
    let level: DisclosureLevel = 0;
    const ids: DisclosureId[] = [];
    for (const item of protectedDisclosures) {
      const formulations = [item.fact, ...item.equivalentFormulations].map(normalize);
      if (formulations.some((phrase) => normalized.includes(phrase))) {
        ids.push(item.id);
        if (item.minimumDisclosureLevel > level) level = item.minimumDisclosureLevel;
      }
    }
    if (ids.length > 0) {
      return { status: "UNSAFE", effectiveDisclosureLevel: level, effectiveDisclosureIds: ids, confidence: 1, reason: "Protected formulation detected independently" };
    }
    if (this.safeTexts.has(normalized)) {
      return { status: "SAFE", effectiveDisclosureLevel: 0, effectiveDisclosureIds: [], confidence: 1, reason: "Exact reviewed zero-disclosure probe" };
    }
    return { status: "UNKNOWN", effectiveDisclosureLevel: 5, effectiveDisclosureIds: [], confidence: 0, reason: "Text is outside the reviewed Phase 0 disclosure set" };
  }
}

export type ProposalValidation =
  | { readonly accepted: true; readonly analysis: DisclosureAnalysis }
  | { readonly accepted: false; readonly reason: string; readonly analysis?: DisclosureAnalysis };

export class DisclosureValidator {
  public constructor(private readonly analyzer: DisclosureAnalyzer) {}

  public validate(input: {
    readonly proposal: InterviewerProposal;
    readonly request: RealizationRequest;
    readonly protectedDisclosures: readonly ProtectedDisclosure[];
  }): ProposalValidation {
    if (input.proposal.realizedAction !== input.request.requiredAction) {
      return { accepted: false, reason: "Model realized an action that application policy did not select" };
    }
    if (input.proposal.speechText === undefined && (input.proposal.boardActions?.length ?? 0) === 0) {
      return { accepted: false, reason: "Proposal contains no deliverable realization" };
    }
    const texts = [input.proposal.speechText ?? "", ...(input.proposal.boardActions ?? []).map((item) => item.content ?? item.annotationPurpose)];
    const analyses = texts.filter((text) => text.length > 0).map((text) => this.analyzer.analyze(text, input.protectedDisclosures));
    if (analyses.some((analysis) => analysis.status === "UNKNOWN" || analysis.confidence < 1)) {
      const uncertain = analyses.find((item) => item.status === "UNKNOWN");
      return {
        accepted: false,
        reason: "Disclosure validation is uncertain and therefore fails closed",
        ...(uncertain === undefined ? {} : { analysis: uncertain })
      };
    }
    const effectiveLevel = analyses.reduce<DisclosureLevel>((maximum, item) => item.effectiveDisclosureLevel > maximum ? item.effectiveDisclosureLevel : maximum, 0);
    const effectiveIds = Array.from(new Set(analyses.flatMap((item) => item.effectiveDisclosureIds)));
    const combined: DisclosureAnalysis = {
      status: analyses.some((item) => item.status === "UNSAFE") ? "UNSAFE" : "SAFE",
      effectiveDisclosureLevel: effectiveLevel,
      effectiveDisclosureIds: effectiveIds,
      confidence: Math.min(...analyses.map((item) => item.confidence)),
      reason: analyses.map((item) => item.reason).join("; ")
    };
    if (combined.status !== "SAFE" || combined.effectiveDisclosureLevel > input.request.maximumDisclosure) {
      return { accepted: false, reason: "Effective disclosure exceeds the application-authorized boundary", analysis: combined };
    }
    return { accepted: true, analysis: combined };
  }
}
