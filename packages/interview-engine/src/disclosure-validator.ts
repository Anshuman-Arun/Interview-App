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

const normalize = (text: string): string =>
  text
    .toLocaleLowerCase()
    .replace(/\bcolours\b/gu, "colors")
    .replace(/\bcolour\b/gu, "color")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();

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
      return {
        status: "SAFE",
        effectiveDisclosureLevel: level,
        effectiveDisclosureIds: ids,
        confidence: 1,
        reason: "Protected formulation classified independently"
      };
    }
    if (this.safeTexts.has(normalized)) {
      return {
        status: "SAFE",
        effectiveDisclosureLevel: 0,
        effectiveDisclosureIds: [],
        confidence: 1,
        reason: "Exact reviewed zero-disclosure probe"
      };
    }
    return {
      status: "UNKNOWN",
      effectiveDisclosureLevel: 5,
      effectiveDisclosureIds: [],
      confidence: 0,
      reason: "Text is outside the reviewed Phase 0 disclosure set"
    };
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
      return { accepted: false, reason: "Proposal action does not match the application-selected pedagogical action" };
    }

    const analysis = this.analyzer.analyze(input.proposal.speechText, input.protectedDisclosures);
    if (analysis.status !== "SAFE") {
      return { accepted: false, reason: "Disclosure analysis is uncertain and therefore fails closed", analysis };
    }
    if (analysis.effectiveDisclosureLevel > input.request.maximumDisclosure) {
      return { accepted: false, reason: "Proposal exceeds the application-selected maximum disclosure level", analysis };
    }

    if (input.request.allowedDisclosureIds !== undefined) {
      const allowed = new Set<DisclosureId>(input.request.allowedDisclosureIds);
      const containsUnauthorizedProtectedDisclosure = analysis.effectiveDisclosureIds.some(
        (disclosureId) => !allowed.has(disclosureId)
      );
      if (containsUnauthorizedProtectedDisclosure) {
        return {
          accepted: false,
          reason: "Proposal contains a protected disclosure outside the application-selected target authorization",
          analysis
        };
      }
    }

    return { accepted: true, analysis };
  }
}
