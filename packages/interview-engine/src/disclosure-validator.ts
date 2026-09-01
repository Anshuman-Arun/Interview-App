import {
  DisclosureAnalysisSchema,
  type DisclosureAnalysis,
  type DisclosureId,
  type DisclosureLevel,
  type InterviewerProposal,
  type ProtectedDisclosure,
  type RealizationRequest
} from "../../domain/src/index.js";

export interface DisclosureAnalyzer {
  readonly analyze: (text: string, protectedDisclosures: readonly ProtectedDisclosure[]) => DisclosureAnalysis;
}

const MAX_DISCLOSURE_ANALYSIS_CHARACTERS = 100_000;
const MAX_PROTECTED_DISCLOSURES = 1_024;
const MAX_EQUIVALENT_FORMULATIONS = 256;
const MAX_ANALYZER_DISCLOSURE_IDS = 256;
const MAX_BOARD_ACTIONS = 256;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const normalize = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bcolours\b/gu, "colors")
    .replace(/\bcolour\b/gu, "color")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();

function unknownAnalysis(reason: string): DisclosureAnalysis {
  return {
    status: "UNKNOWN",
    effectiveDisclosureLevel: 5,
    effectiveDisclosureIds: [],
    confidence: 0,
    reason
  };
}

function analyzerResultWithinBounds(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const ids = value["effectiveDisclosureIds"];
  const reason = value["reason"];
  return Array.isArray(ids)
    && ids.length <= MAX_ANALYZER_DISCLOSURE_IDS
    && typeof reason === "string"
    && reason.length > 0
    && reason.length <= MAX_DISCLOSURE_ANALYSIS_CHARACTERS;
}

function protectedMetadataWithinBounds(
  protectedDisclosures: readonly ProtectedDisclosure[]
): boolean {
  if (protectedDisclosures.length > MAX_PROTECTED_DISCLOSURES) return false;
  for (const disclosure of protectedDisclosures) {
    if (
      disclosure.fact.length === 0
      || disclosure.fact.length > MAX_DISCLOSURE_ANALYSIS_CHARACTERS
      || disclosure.equivalentFormulations.length === 0
      || disclosure.equivalentFormulations.length > MAX_EQUIVALENT_FORMULATIONS
      || disclosure.equivalentFormulations.some(
        (formulation) =>
          formulation.length === 0
          || formulation.length > MAX_DISCLOSURE_ANALYSIS_CHARACTERS
      )
    ) return false;
  }
  return true;
}

export class ClosedWorldDisclosureAnalyzer implements DisclosureAnalyzer {
  private readonly safeTexts: ReadonlySet<string>;

  public constructor(safeTexts: readonly string[]) {
    const normalized = safeTexts.map((text) => {
      if (text.length === 0 || text.length > MAX_DISCLOSURE_ANALYSIS_CHARACTERS) {
        throw new Error("Reviewed safe text is outside the bounded disclosure-analysis input size");
      }
      const value = normalize(text);
      if (value.length === 0) {
        throw new Error("Reviewed safe text must contain analyzable alphanumeric content");
      }
      return value;
    });
    this.safeTexts = new Set(normalized);
  }

  public analyze(text: string, protectedDisclosures: readonly ProtectedDisclosure[]): DisclosureAnalysis {
    if (text.length > MAX_DISCLOSURE_ANALYSIS_CHARACTERS) {
      return unknownAnalysis("Text exceeds the bounded disclosure-analysis input size");
    }
    if (!protectedMetadataWithinBounds(protectedDisclosures)) {
      return unknownAnalysis("Protected disclosure metadata exceeds the bounded disclosure-analysis input size");
    }

    const normalized = normalize(text);
    let level: DisclosureLevel = 0;
    const ids: DisclosureId[] = [];
    for (const item of protectedDisclosures) {
      const formulations = [item.fact, ...item.equivalentFormulations].map(normalize);
      if (formulations.some((phrase) => phrase.length === 0)) {
        return unknownAnalysis("Protected disclosure metadata normalizes to an empty formulation");
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
    if (normalized.length > 0 && this.safeTexts.has(normalized)) {
      return {
        status: "SAFE",
        effectiveDisclosureLevel: 0,
        effectiveDisclosureIds: [],
        confidence: 1,
        reason: "Exact reviewed zero-disclosure probe"
      };
    }
    return unknownAnalysis("Text is outside the reviewed Phase 0 disclosure set");
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
    if (
      (input.proposal.speechText?.length ?? 0) > MAX_DISCLOSURE_ANALYSIS_CHARACTERS
      || (input.proposal.boardActions?.length ?? 0) > MAX_BOARD_ACTIONS
      || (input.proposal.boardActions ?? []).some(
        (action) =>
          (action.content?.length ?? 0) > MAX_DISCLOSURE_ANALYSIS_CHARACTERS
          || action.annotationPurpose.length > MAX_DISCLOSURE_ANALYSIS_CHARACTERS
      )
    ) {
      return { accepted: false, reason: "Proposal exceeds the bounded disclosure-validation input size" };
    }
    if (!protectedMetadataWithinBounds(input.protectedDisclosures)) {
      return { accepted: false, reason: "Protected disclosure metadata exceeds the bounded validation input size" };
    }

    const disclosureById = new Map<DisclosureId, ProtectedDisclosure>();
    for (const disclosure of input.protectedDisclosures) {
      if (disclosureById.has(disclosure.id)) {
        return { accepted: false, reason: "Protected disclosure metadata contains duplicate IDs" };
      }
      disclosureById.set(disclosure.id, disclosure);
    }

    const texts: string[] = [];
    if (input.proposal.speechText !== undefined) texts.push(input.proposal.speechText);
    for (const action of input.proposal.boardActions ?? []) {
      if (action.content !== undefined && action.content.length > 0) texts.push(action.content);
      texts.push(action.annotationPurpose);
    }
    if (texts.length === 0) {
      return { accepted: false, reason: "Proposal contains no analyzable deliverable realization" };
    }

    const analyses: DisclosureAnalysis[] = [];
    for (const text of texts) {
      let rawAnalysis: unknown;
      try {
        rawAnalysis = this.analyzer.analyze(text, input.protectedDisclosures);
      } catch {
        return {
          accepted: false,
          reason: "Disclosure analyzer failed and therefore fails closed"
        };
      }
      if (!analyzerResultWithinBounds(rawAnalysis)) {
        return {
          accepted: false,
          reason: "Disclosure analyzer returned an invalid or oversized result and therefore fails closed"
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

    const effectiveIds = Array.from(new Set(analyses.flatMap((item) => item.effectiveDisclosureIds)));
    let metadataFloor: DisclosureLevel = 0;
    for (const disclosureId of effectiveIds) {
      const disclosure = disclosureById.get(disclosureId);
      if (disclosure === undefined) {
        return {
          accepted: false,
          reason: "Disclosure analyzer referenced an unknown protected disclosure"
        };
      }
      if (disclosure.minimumDisclosureLevel > metadataFloor) {
        metadataFloor = disclosure.minimumDisclosureLevel;
      }
    }
    const analyzedLevel = analyses.reduce<DisclosureLevel>(
      (maximum, item) => item.effectiveDisclosureLevel > maximum ? item.effectiveDisclosureLevel : maximum,
      0
    );
    const effectiveLevel = analyzedLevel > metadataFloor ? analyzedLevel : metadataFloor;
    const combined: DisclosureAnalysis = {
      status: "SAFE",
      effectiveDisclosureLevel: effectiveLevel,
      effectiveDisclosureIds: effectiveIds,
      confidence: Math.min(...analyses.map((item) => item.confidence)),
      reason: analyses.map((item) => item.reason).join("; ")
    };

    const allowed = new Set<DisclosureId>(input.request.allowedDisclosureIds ?? []);
    if (allowed.size !== (input.request.allowedDisclosureIds?.length ?? 0)) {
      return {
        accepted: false,
        reason: "Application-selected target authorization contains duplicate protected disclosures",
        analysis: combined
      };
    }
    for (const disclosureId of allowed) {
      const disclosure = disclosureById.get(disclosureId);
      if (disclosure === undefined) {
        return {
          accepted: false,
          reason: "Application-selected target authorization references an unknown protected disclosure",
          analysis: combined
        };
      }
      if (disclosure.minimumDisclosureLevel > input.request.maximumDisclosure) {
        return {
          accepted: false,
          reason: "Application-selected target authorization exceeds its numeric disclosure ceiling",
          analysis: combined
        };
      }
    }

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
