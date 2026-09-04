import {
  DisclosureAnalysisSchema,
  type BoardAction,
  type BoardSceneContext,
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
const MAX_TOTAL_PROPOSAL_TEXT_CHARACTERS = 1_000_000;
const MAX_PROTECTED_DISCLOSURES = 1_024;
const MAX_EQUIVALENT_FORMULATIONS = 256;
const MAX_TOTAL_EQUIVALENT_FORMULATIONS = 4_096;
const MAX_TOTAL_PROTECTED_DISCLOSURE_CHARACTERS = 1_000_000;
const MAX_DISCLOSURE_ANALYSIS_WORK_CHARACTERS = 10_000_000;
const MAX_ANALYZER_DISCLOSURE_IDS = 256;
const MAX_TOTAL_ANALYZER_DISCLOSURE_IDS = 65_536;
const MAX_TOTAL_ANALYZER_REASON_CHARACTERS = 1_000_000;
const MAX_BOARD_ACTIONS = 256;
const MAX_REVIEWED_SAFE_TEXTS = 1_024;
const MAX_TOTAL_REVIEWED_SAFE_TEXT_CHARACTERS = 1_000_000;

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

const normalizeReviewedText = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bcolours\b/gu, "colors")
    .replace(/\bcolour\b/gu, "color")
    .replace(/\s+/gu, " ")
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

interface ProtectedMatch {
  readonly ok: boolean;
  readonly ids: readonly DisclosureId[];
  readonly level: DisclosureLevel;
}

function deriveProtectedMatch(
  text: string,
  protectedDisclosures: readonly ProtectedDisclosure[]
): ProtectedMatch {
  const normalized = normalize(text);
  const ids: DisclosureId[] = [];
  let level: DisclosureLevel = 0;

  for (const disclosure of protectedDisclosures) {
    const formulations = [disclosure.fact, ...disclosure.equivalentFormulations]
      .map(normalize);
    if (formulations.some((formulation) => formulation.length === 0)) {
      return { ok: false, ids: [], level: 0 };
    }
    if (formulations.some((formulation) => normalized.includes(formulation))) {
      ids.push(disclosure.id);
      if (disclosure.minimumDisclosureLevel > level) {
        level = disclosure.minimumDisclosureLevel;
      }
    }
  }

  return { ok: true, ids, level };
}

function isExactProtectedRealization(
  normalizedReviewedText: string,
  protectedDisclosures: readonly ProtectedDisclosure[]
): boolean {
  return protectedDisclosures.some((disclosure) =>
    [disclosure.fact, ...disclosure.equivalentFormulations]
      .some((formulation) => normalizeReviewedText(formulation) === normalizedReviewedText)
  );
}

function protectedMetadataWithinBounds(
  protectedDisclosures: readonly ProtectedDisclosure[]
): boolean {
  if (protectedDisclosures.length > MAX_PROTECTED_DISCLOSURES) return false;
  let totalFormulations = 0;
  let totalCharacters = 0;
  for (const disclosure of protectedDisclosures) {
    if (
      disclosure.fact.length === 0
      || disclosure.fact.length > MAX_DISCLOSURE_ANALYSIS_CHARACTERS
      || disclosure.equivalentFormulations.length === 0
      || disclosure.equivalentFormulations.length > MAX_EQUIVALENT_FORMULATIONS
    ) return false;
    totalCharacters += disclosure.fact.length;
    totalFormulations += disclosure.equivalentFormulations.length;
    if (
      totalCharacters > MAX_TOTAL_PROTECTED_DISCLOSURE_CHARACTERS
      || totalFormulations > MAX_TOTAL_EQUIVALENT_FORMULATIONS
    ) return false;
    for (const formulation of disclosure.equivalentFormulations) {
      if (
        formulation.length === 0
        || formulation.length > MAX_DISCLOSURE_ANALYSIS_CHARACTERS
      ) return false;
      totalCharacters += formulation.length;
      if (totalCharacters > MAX_TOTAL_PROTECTED_DISCLOSURE_CHARACTERS) return false;
    }
  }
  return true;
}

function protectedMetadataCharacterCount(
  protectedDisclosures: readonly ProtectedDisclosure[]
): number {
  let total = 0;
  for (const disclosure of protectedDisclosures) {
    total += disclosure.fact.length;
    for (const formulation of disclosure.equivalentFormulations) total += formulation.length;
  }
  return total;
}

function protectedMetadataFormulationCount(
  protectedDisclosures: readonly ProtectedDisclosure[]
): number {
  return protectedDisclosures.reduce(
    (total, disclosure) => total + 1 + disclosure.equivalentFormulations.length,
    0
  );
}

interface BoardDisclosureBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const BOARD_DISCLOSURE_ASSOCIATION_MARGIN = 32;

function absoluteBoardActionDisclosureBounds(
  action: BoardAction
): BoardDisclosureBounds | undefined {
  const points = action.points;
  if (points !== undefined && points.length > 0) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY)
    };
  }

  const placement = action.placement;
  if (placement?.x === undefined || placement.y === undefined) return undefined;
  switch (action.operation) {
    case "write_text":
      return { x: placement.x, y: placement.y, width: 220, height: 96 };
    case "write_equation":
      return { x: placement.x, y: placement.y, width: 220, height: 56 };
    case "draw_rectangle":
    case "draw_ellipse":
      if (action.width === undefined || action.height === undefined) return undefined;
      return {
        x: placement.x,
        y: placement.y,
        width: action.width,
        height: action.height
      };
    default:
      return undefined;
  }
}

function boardBoundsAreAssociated(
  actionBounds: BoardDisclosureBounds,
  shapeBounds: BoardDisclosureBounds
): boolean {
  const margin = BOARD_DISCLOSURE_ASSOCIATION_MARGIN;
  return (
    actionBounds.x <= shapeBounds.x + shapeBounds.width + margin
    && actionBounds.x + actionBounds.width >= shapeBounds.x - margin
    && actionBounds.y <= shapeBounds.y + shapeBounds.height + margin
    && actionBounds.y + actionBounds.height >= shapeBounds.y - margin
  );
}

function boardTargetDisclosureTexts(
  action: BoardAction,
  boardScene: BoardSceneContext | undefined
): readonly string[] {
  if (boardScene === undefined) return [];
  const shapeIds = new Set<string>();
  if (action.targetShapeId !== undefined) shapeIds.add(action.targetShapeId);
  if (action.placement?.anchorShapeId !== undefined) {
    shapeIds.add(action.placement.anchorShapeId);
  }
  if (action.operation === "draw_arrow_between") {
    if (action.fromShapeId !== undefined) shapeIds.add(action.fromShapeId);
    if (action.toShapeId !== undefined) shapeIds.add(action.toShapeId);
  }

  const absoluteBounds = absoluteBoardActionDisclosureBounds(action);
  if (absoluteBounds !== undefined) {
    for (const shape of boardScene.shapes) {
      if (boardBoundsAreAssociated(absoluteBounds, shape.bounds)) {
        shapeIds.add(shape.shapeId);
      }
    }
  }

  const texts: string[] = [];
  for (const shapeId of shapeIds) {
    const shape = boardScene.shapes.find((item) => item.shapeId === shapeId);
    if (shape === undefined) continue;
    if (shape.text !== undefined && shape.text.length > 0) texts.push(shape.text);
    const interpretation = shape.semanticObservation?.interpretation;
    if (interpretation !== undefined && interpretation.length > 0) {
      texts.push(interpretation);
    }
  }
  return texts;
}

function combineSafeAnalyses(
  analyses: readonly DisclosureAnalysis[],
  deterministicIds: readonly DisclosureId[],
  deterministicLevel: DisclosureLevel,
  additionalIds: readonly DisclosureId[],
  disclosureById: ReadonlyMap<DisclosureId, ProtectedDisclosure>
): DisclosureAnalysis {
  if (analyses.length === 0) {
    throw new Error("Cannot combine an empty disclosure-analysis realization");
  }

  const effectiveIds = Array.from(new Set([
    ...deterministicIds,
    ...analyses.flatMap((item) => item.effectiveDisclosureIds),
    ...additionalIds
  ]));
  let metadataFloor: DisclosureLevel = deterministicLevel;
  for (const disclosureId of effectiveIds) {
    const disclosure = disclosureById.get(disclosureId);
    if (disclosure === undefined) {
      throw new Error("Cannot combine an unknown protected disclosure identity");
    }
    if (disclosure.minimumDisclosureLevel > metadataFloor) {
      metadataFloor = disclosure.minimumDisclosureLevel;
    }
  }

  const analyzedLevel = analyses.reduce<DisclosureLevel>(
    (maximum, item) =>
      item.effectiveDisclosureLevel > maximum ? item.effectiveDisclosureLevel : maximum,
    0
  );
  const effectiveLevel = analyzedLevel > metadataFloor ? analyzedLevel : metadataFloor;
  return {
    status: "SAFE",
    effectiveDisclosureLevel: effectiveLevel,
    effectiveDisclosureIds: effectiveIds,
    confidence: Math.min(...analyses.map((item) => item.confidence)),
    reason: analyses.map((item) => item.reason).join("; ")
  };
}

export class ClosedWorldDisclosureAnalyzer implements DisclosureAnalyzer {
  private readonly safeTexts: ReadonlySet<string>;

  public constructor(safeTexts: readonly string[]) {
    if (safeTexts.length > MAX_REVIEWED_SAFE_TEXTS) {
      throw new Error("Reviewed safe-text set exceeds the bounded disclosure-analysis size");
    }
    let totalCharacters = 0;
    const normalized = safeTexts.map((text) => {
      if (text.length === 0 || text.length > MAX_DISCLOSURE_ANALYSIS_CHARACTERS) {
        throw new Error("Reviewed safe text is outside the bounded disclosure-analysis input size");
      }
      totalCharacters += text.length;
      if (totalCharacters > MAX_TOTAL_REVIEWED_SAFE_TEXT_CHARACTERS) {
        throw new Error("Reviewed safe-text set exceeds the bounded aggregate text size");
      }
      if (normalize(text).length === 0) {
        throw new Error("Reviewed safe text must contain analyzable alphanumeric content");
      }
      return normalizeReviewedText(text);
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
    const normalizedReviewedText = normalizeReviewedText(text);
    const protectedMatch = deriveProtectedMatch(text, protectedDisclosures);
    if (!protectedMatch.ok) {
      return unknownAnalysis("Protected disclosure metadata normalizes to an empty formulation");
    }
    if (protectedMatch.ids.length > 0) {
      if (
        !this.safeTexts.has(normalizedReviewedText)
        && !isExactProtectedRealization(normalizedReviewedText, protectedDisclosures)
      ) {
        return unknownAnalysis(
          "Protected formulation was detected, but the complete realization is outside the reviewed set"
        );
      }
      return {
        status: "SAFE",
        effectiveDisclosureLevel: protectedMatch.level,
        effectiveDisclosureIds: [...protectedMatch.ids],
        confidence: 1,
        reason: "Complete realization is reviewed and protected content is classified independently"
      };
    }
    if (normalized.length > 0 && this.safeTexts.has(normalizedReviewedText)) {
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

export interface RealizationDisclosureAnalyses {
  readonly speech: DisclosureAnalysis | null;
  readonly boardActions: readonly DisclosureAnalysis[];
}

export type ProposalValidation =
  | {
      readonly accepted: true;
      readonly analysis: DisclosureAnalysis;
      readonly realizations: RealizationDisclosureAnalyses;
    }
  | { readonly accepted: false; readonly reason: string; readonly analysis?: DisclosureAnalysis };

export class DisclosureValidator {
  public constructor(private readonly analyzer: DisclosureAnalyzer) {}

  public validate(input: {
    readonly proposal: InterviewerProposal;
    readonly request: RealizationRequest;
    readonly protectedDisclosures: readonly ProtectedDisclosure[];
    readonly boardScene?: BoardSceneContext;
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

    const realizationTexts: string[][] = [];
    if (input.proposal.speechText !== undefined) {
      realizationTexts.push([input.proposal.speechText]);
    }
    const boardActions = input.proposal.boardActions ?? [];
    const boardTargetTexts = boardActions.map((action) =>
      boardTargetDisclosureTexts(action, input.boardScene)
    );
    for (const action of boardActions) {
      const actionTexts: string[] = [];
      if (action.content !== undefined && action.content.length > 0) {
        actionTexts.push(action.content);
      }
      actionTexts.push(action.annotationPurpose);
      realizationTexts.push(actionTexts);
    }
    const texts = realizationTexts.flat();
    if (texts.length === 0) {
      return { accepted: false, reason: "Proposal contains no analyzable deliverable realization" };
    }
    const totalProposalTextCharacters = texts.reduce((total, text) => total + text.length, 0);
    if (totalProposalTextCharacters > MAX_TOTAL_PROPOSAL_TEXT_CHARACTERS) {
      return { accepted: false, reason: "Proposal exceeds the bounded aggregate disclosure-validation input size" };
    }
    const metadataCharacters = protectedMetadataCharacterCount(input.protectedDisclosures);
    const formulationCount = protectedMetadataFormulationCount(input.protectedDisclosures);
    const boardTargetTextCount = boardTargetTexts.reduce(
      (total, group) => total + group.length,
      0
    );
    const boardTargetTextCharacters = boardTargetTexts.reduce(
      (total, group) =>
        total + group.reduce((groupTotal, text) => groupTotal + text.length, 0),
      0
    );
    if (
      (texts.length + boardTargetTextCount) * metadataCharacters
        > MAX_DISCLOSURE_ANALYSIS_WORK_CHARACTERS
      || (totalProposalTextCharacters + boardTargetTextCharacters) * formulationCount
        > MAX_DISCLOSURE_ANALYSIS_WORK_CHARACTERS
    ) {
      return { accepted: false, reason: "Proposal exceeds the bounded disclosure-analysis work budget" };
    }

    const analyses: DisclosureAnalysis[] = [];
    const protectedMatches: ProtectedMatch[] = [];
    const boardTargetMatches: ProtectedMatch[] = [];
    const deterministicIds = new Set<DisclosureId>();
    let deterministicLevel: DisclosureLevel = 0;

    for (const targetTexts of boardTargetTexts) {
      const targetIds = new Set<DisclosureId>();
      let targetLevel: DisclosureLevel = 0;
      for (const text of targetTexts) {
        const targetMatch = deriveProtectedMatch(text, input.protectedDisclosures);
        if (!targetMatch.ok) {
          return {
            accepted: false,
            reason: "Protected board-target disclosure metadata cannot be analyzed deterministically"
          };
        }
        for (const disclosureId of targetMatch.ids) {
          targetIds.add(disclosureId);
          deterministicIds.add(disclosureId);
        }
        if (targetMatch.level > targetLevel) targetLevel = targetMatch.level;
        if (targetMatch.level > deterministicLevel) deterministicLevel = targetMatch.level;
      }
      boardTargetMatches.push({
        ok: true,
        ids: [...targetIds],
        level: targetLevel
      });
    }
    let totalAnalyzerReasonCharacters = 0;
    let totalAnalyzerDisclosureIds = 0;
    for (const text of texts) {
      const protectedMatch = deriveProtectedMatch(text, input.protectedDisclosures);
      if (!protectedMatch.ok) {
        return {
          accepted: false,
          reason: "Protected disclosure metadata cannot be analyzed deterministically"
        };
      }
      protectedMatches.push(protectedMatch);
      for (const disclosureId of protectedMatch.ids) deterministicIds.add(disclosureId);
      if (protectedMatch.level > deterministicLevel) {
        deterministicLevel = protectedMatch.level;
      }
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
      totalAnalyzerReasonCharacters += parsed.data.reason.length;
      totalAnalyzerDisclosureIds += parsed.data.effectiveDisclosureIds.length;
      if (
        totalAnalyzerReasonCharacters > MAX_TOTAL_ANALYZER_REASON_CHARACTERS
        || totalAnalyzerDisclosureIds > MAX_TOTAL_ANALYZER_DISCLOSURE_IDS
      ) {
        return {
          accepted: false,
          reason: "Disclosure analyzer results exceed the bounded aggregate output size"
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

    if (
      new Set(input.proposal.claimedDisclosureIds).size
      !== input.proposal.claimedDisclosureIds.length
    ) {
      return {
        accepted: false,
        reason: "Model claimed duplicate protected disclosure identities"
      };
    }
    for (const disclosureId of input.proposal.claimedDisclosureIds) {
      if (!disclosureById.has(disclosureId)) {
        return {
          accepted: false,
          reason: "Model claimed an unknown protected disclosure identity"
        };
      }
    }

    for (const analysis of analyses) {
      for (const disclosureId of analysis.effectiveDisclosureIds) {
        if (!disclosureById.has(disclosureId)) {
          return {
            accepted: false,
            reason: "Disclosure analyzer referenced an unknown protected disclosure"
          };
        }
      }
    }

    const baseRealizationAnalyses: DisclosureAnalysis[] = [];
    const speechOffset = input.proposal.speechText === undefined ? 0 : 1;
    let analysisOffset = 0;
    for (let realizationIndex = 0; realizationIndex < realizationTexts.length; realizationIndex += 1) {
      const group = realizationTexts[realizationIndex];
      if (group === undefined) {
        return {
          accepted: false,
          reason: "Disclosure realization attribution failed closed"
        };
      }
      const groupAnalyses = analyses.slice(analysisOffset, analysisOffset + group.length);
      const groupMatches = protectedMatches.slice(analysisOffset, analysisOffset + group.length);
      analysisOffset += group.length;
      const targetMatch = realizationIndex < speechOffset
        ? undefined
        : boardTargetMatches[realizationIndex - speechOffset];
      const groupDeterministicIds = Array.from(new Set([
        ...groupMatches.flatMap((match) => match.ids),
        ...(targetMatch?.ids ?? [])
      ]));
      const emittedLevel = groupMatches.reduce<DisclosureLevel>(
        (maximum, match) => match.level > maximum ? match.level : maximum,
        0
      );
      const groupDeterministicLevel =
        targetMatch !== undefined && targetMatch.level > emittedLevel
          ? targetMatch.level
          : emittedLevel;
      baseRealizationAnalyses.push(combineSafeAnalyses(
        groupAnalyses,
        groupDeterministicIds,
        groupDeterministicLevel,
        [],
        disclosureById
      ));
    }

    const localizedIds = new Set(
      baseRealizationAnalyses.flatMap((analysis) => analysis.effectiveDisclosureIds)
    );
    const unlocalizedClaimedIds = input.proposal.claimedDisclosureIds.filter(
      (disclosureId) => !localizedIds.has(disclosureId)
    );
    const realizationAnalyses = unlocalizedClaimedIds.length === 0
      ? baseRealizationAnalyses
      : baseRealizationAnalyses.map((analysis) =>
          combineSafeAnalyses(
            [analysis],
            [],
            0,
            unlocalizedClaimedIds,
            disclosureById
          )
        );

    let combined: DisclosureAnalysis;
    try {
      combined = combineSafeAnalyses(
        analyses,
        [...deterministicIds],
        deterministicLevel,
        input.proposal.claimedDisclosureIds,
        disclosureById
      );
    } catch {
      return {
        accepted: false,
        reason: "Disclosure analysis could not be combined safely"
      };
    }

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
    if (input.proposal.claimedDisclosureLevel > input.request.maximumDisclosure) {
      return {
        accepted: false,
        reason: "Model claimed a disclosure level above the application-authorized boundary",
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

    const speechAnalysis = input.proposal.speechText === undefined
      ? null
      : realizationAnalyses[0] ?? null;
    const boardActionAnalyses = realizationAnalyses.slice(speechOffset);
    if (
      (input.proposal.speechText !== undefined && speechAnalysis === null)
      || boardActionAnalyses.length !== (input.proposal.boardActions?.length ?? 0)
    ) {
      return {
        accepted: false,
        reason: "Disclosure realization attribution failed closed",
        analysis: combined
      };
    }

    return {
      accepted: true,
      analysis: combined,
      realizations: {
        speech: speechAnalysis,
        boardActions: boardActionAnalyses
      }
    };
  }
}
