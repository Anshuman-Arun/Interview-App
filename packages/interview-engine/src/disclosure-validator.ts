import type {
  DisclosureAnalysisSchema,
  type DisclosureAnalysis,
  type DisclosureId,
  type DisclosureLevel,
  InterviewerProposal,
  ProtectedDisclosure,
  RealizationRequest
} from "../../domain/src/index.js";

export interface DisclosureAnalyzer {
  readonly analyze: (text: string, protectedDisclosures: readonly ProtectedDisclosure[]) => DisclosureAnalysis;
}

const MAX_DISCLOSURE_ANALYSIS_CHARACTERS = 100_000;

const normalize = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
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
    if (text.length > MAX_DISCLOSURE_ANALYSIS_CHARACTERS) {
      return {
        status: "UNKNOWN",
        effectiveDisclosureLevel: 5,
        effectiveDisclosureIds: [],
        confidence: 0,
        reason: "Text exceeds the bounded disclosure-analysis input size"
      };
    }

    const normalized = normalize(text);
    let level: DisclosureLevel = 0;
    const ids: DisclosureId[] = [];
    for (const item of protectedDisclosures) {
      const formulations = [item.fact, ...item.equivalentFormulations].map(normalize);
      if (formulations.some((phrase) => phrase.length === 0)) {
        return {
          status: "UNKNOWN",
          effectiveDisclosureLevel: 5,
          effectiveDisclosureIds: [],
          confidence: 0,
          reason: "Protected disclosure metadata normalizes to an empty formulation"
        };
      }
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
      return { accepted: false, reason: "Model realized an action that application policy did not select" };
    }
    if (input.proposal.speechText === undefined && (input.proposal.boardActions?.length ?? 0) === 0) {
      return { accepted: false, reason: "Proposal contains no deliverable realization" };
    }

    const texts = [
      input.proposal.speechText ?? "",
      ...(input.proposal.boardActions ?? []).map((item) => item.content ?? item.annotationPurpose)
    ];
    const analyses: DisclosureAnalysis[] = [];
    for (const text of texts.filter((candidate) => candidate.length > 0)) {
      let rawAnalysis: unknown;
      try {
        rawAnalysis = this.analyzer.analyze(text, input.protectedDisclosures);
      } catch {
        return {
          accepted: false,
          reason: "Disclosure analyzer failed and therefore fails closed"
        };
      }
      const parsed = DisclosureAnalysisSchema.safeParse(rawAnalysis);
      if (!parsed.success) {
        return {
          accepted: false,
          reason: "Disclosure analyzer returned an invalid result and therefore fails closed"
        };
      }
      analyses.push(parsed.data);
    }

    const unsafe = analyses.find((analysis) => analysis.status === "UNSAFE");
    if (unsafe !== undefined) {
      return {
        accepted: false,
        reason: "Disclosure analysis classified proposal content as unsafe",
        analysis: unsafe
      };
    }
    if (analyses.some((analysis) => analysis.status !== "SAFE" || analysis.confidence < 1)) {
      const uncertain = analyses.find((item) => item.status !== "SAFE" || item.confidence < 1);
      return {
        accepted: false,
        reason: "Disclosure validation is uncertain and therefore fails closed",
        ...(uncertain === undefined ? {} : { analysis: uncertain })
      };
    }

    const effectiveLevel = analyses.reduce<DisclosureLevel>(
      (maximum, item) => item.effectiveDisclosureLevel > maximum ? item.effectiveDisclosureLevel : maximum,
      0
    );
    const effectiveIds = Array.from(new Set(analyses.flatMap((item) => item.effectiveDisclosureIds)));
    const combined: DisclosureAnalysis = {
      status: "SAFE",
      effectiveDisclosureLevel: effectiveLevel,
      effectiveDisclosureIds: effectiveIds,
      confidence: Math.min(...analyses.map((item) => item.confidence)),
      reason: analyses.map((item) => item.reason).join("; ")
    };

    if (combined.effectiveDisclosureLevel > input.request.maximumDisclosure) {
      return {
        accepted: false,
        reason: "Effective disclosure exceeds the application-authorized boundary",
        analysis: combined
      };
    }
    if (input.proposal.claimedDisclosureLevel < combined.effectiveDisclosureLevel) {
      return {
        accepted: false,
        reason: "Model claimed disclosure level understates effective disclosure",
        analysis: combined
      };
    }

    const protectedDisclosureIds = new Set(input.protectedDisclosures.map((item) => item.id));
    const allowed = new Set<DisclosureId>(input.request.allowedDisclosureIds ?? []);
    if ([...allowed].some((disclosureId) => !protectedDisclosureIds.has(disclosureId))) {
      return {
        accepted: false,
        reason: "Application-selected target authorization references an unknown protected disclosure",
        analysis: combined
      };
    }
    if (combined.effectiveDisclosureIds.some((disclosureId) => !allowed.has(disclosureId))) {
      return {
        accepted: false,
        reason: "Proposal contains a protected disclosure outside the application-selected target authorization",
        analysis: combined
      };
    }

    return { accepted: true, analysis: combined };
  }
}
