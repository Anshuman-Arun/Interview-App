import type {
  DeliveryMedium,
  DeliveryStatus,
  DisclosureLevel,
  EvidenceKey,
  EvidenceValue,
  EventId,
  GenerationBasis,
  GenerationId,
  SessionId,
  SocraticAction,
  VerificationStatus
} from "../../domain/src/index.js";
import type { EventType } from "../../events/src/index.js";
import type { ReplayBounds, TextPreview, TruncationInfo } from "./bounds.js";

export type ReplayProjectionIssueCode =
  | "UNKNOWN_EVENT_SEMANTICS"
  | "EVENT_LIMIT_REACHED"
  | "TIMELINE_LIMIT_REACHED"
  | "CURRENT_STATE_UNAVAILABLE";

export interface ReplayProjectionIssue {
  readonly code: ReplayProjectionIssueCode;
  readonly sequence?: number;
  readonly eventType?: string;
}

export interface ReplayEventProvenance {
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly persistedSchemaVersion: number;
  readonly logicalSchemaVersion?: number;
  readonly persistedType: string;
  readonly logicalType?: EventType;
  readonly source: string;
  readonly wallTime: string;
  readonly elapsedMs: number;
  readonly causationId: string;
  readonly correlationId: string;
}

export interface ReplayRelationRefs {
  readonly utteranceId?: string;
  readonly inputEpisodeId?: string;
  readonly turnId?: string;
  readonly generationId?: GenerationId;
  readonly deliveryId?: string;
  readonly requestId?: string;
}

export type ReplayPresentationState =
  | "GENERATED"
  | "AUTHORIZED"
  | "DELIVERING"
  | "PRESENTED"
  | "POSSIBLY_PRESENTED"
  | "CANCELLED";

export interface ReplayDisclosureSummary {
  readonly effectiveDisclosureLevel: DisclosureLevel;
  readonly disclosureIds: readonly string[];
  readonly truncation: TruncationInfo;
}

export interface ReplayBoardActionDetail {
  readonly operation: string;
  readonly content?: TextPreview;
  readonly targetShapeId?: string;
  readonly expectedShapeRevision?: number;
}

export interface ReplayDeliveryDetail {
  readonly deliveryId: string;
  readonly generationId: GenerationId;
  readonly medium: DeliveryMedium;
  readonly status: DeliveryStatus;
  readonly presentationState: ReplayPresentationState;
  readonly disclosure: ReplayDisclosureSummary;
  readonly text?: TextPreview;
  readonly audioReferenceRecorded?: boolean;
  readonly boardAction?: ReplayBoardActionDetail;
}

export interface ReplayGenerationDetail {
  readonly generationId: GenerationId;
  readonly phase:
    | "STARTED"
    | "CONTEXT_COMPILED"
    | "PROPOSAL_RECEIVED"
    | "FORMAL_INTERPRETATION_RECEIVED"
    | "FORMAL_INTERPRETATION_REJECTED"
    | "VALIDATED"
    | "REJECTED"
    | "SUPERSEDED";
  readonly provider?: string;
  readonly basis?: GenerationBasis;
  readonly realizedAction?: SocraticAction;
  readonly claimedDisclosureLevel?: DisclosureLevel;
  readonly claimedDisclosureIdCount?: number;
  readonly proposalTextPersisted?: boolean;
  readonly proposalBoardActionCount?: number;
  readonly contextManifest?: {
    readonly compilerVersion: string;
    readonly problemId: string;
    readonly problemVersion: string;
    readonly contextSha256: string;
    readonly reasoningGraphSha256: string;
  };
  readonly reason?: TextPreview;
  readonly formalInterpretationPersisted?: boolean;
}

export interface ReplayEvidenceDetail {
  readonly transition: "PROPOSED" | "UPDATED" | "INVALIDATED";
  readonly key: EvidenceKey;
  readonly value?: string;
  readonly inferenceConfidence?: number;
  readonly supportingEventIds?: readonly EventId[];
  readonly supportingEventIdsTruncation?: TruncationInfo;
  readonly supersedesEventId?: EventId;
  readonly invalidatesEventId?: EventId;
  readonly reason?: TextPreview;
}

export interface ReplayVerificationDetail {
  readonly phase: "REQUESTED" | "ACCEPTED" | "DISCARDED";
  readonly verificationRequestId: string;
  readonly verifier?: string;
  readonly evidenceKey?: EvidenceKey;
  readonly basis?: GenerationBasis;
  readonly candidateFormalInterpretationPersisted?: boolean;
  readonly interpretationConfidence?: number;
  readonly resultStatus?: VerificationStatus;
  readonly reason?: TextPreview;
  readonly sourceGenerationId?: GenerationId;
  readonly sourceProposalRequestId?: string;
}

export interface ReplayPolicyDetail {
  readonly requiredAction: SocraticAction;
  readonly maximumDisclosure: DisclosureLevel;
  readonly targetPersisted: boolean;
}

export interface ReplayRevisionDetail {
  readonly transcriptRevision?: number;
  readonly boardRevision?: number;
  readonly problemStateRevision?: number;
  readonly policyRevision?: number;
  readonly contextEpoch?: number;
}

export type ReplayStateValidation =
  | "VALIDATED"
  | "UNKNOWN_EVENT"
  | "UNAVAILABLE_AFTER_UNKNOWN";

export interface ReplayTimelineEntry {
  readonly kind: EventType | "UNKNOWN_EVENT";
  readonly summary: string;
  readonly stateValidation: ReplayStateValidation;
  readonly provenance: ReplayEventProvenance;
  readonly relations: ReplayRelationRefs;
  readonly text?: TextPreview;
  readonly delivery?: ReplayDeliveryDetail;
  readonly generation?: ReplayGenerationDetail;
  readonly evidence?: ReplayEvidenceDetail;
  readonly verification?: ReplayVerificationDetail;
  readonly policy?: ReplayPolicyDetail;
  readonly revisions?: ReplayRevisionDetail;
  readonly unknown?: {
    readonly eventType: string;
    readonly schemaVersion: number;
  };
}

export interface ReplayTimelineProjection {
  readonly sessionId: SessionId | null;
  readonly totalEventCount: number;
  readonly entries: readonly ReplayTimelineEntry[];
  readonly eventTruncation: TruncationInfo;
  readonly timelineTruncation: TruncationInfo;
  readonly complete: boolean;
  readonly issues: readonly ReplayProjectionIssue[];
  readonly bounds: ReplayBounds;
}

export interface ReplayEvidenceValue {
  readonly value: EvidenceValue["value"];
  readonly inferenceConfidence: number;
  readonly evidenceEventIds: readonly EventId[];
  readonly evidenceEventIdsTruncation: TruncationInfo;
  readonly lastUpdatedSequence: number;
}

export interface ReplayEvidenceHistoryEntry {
  readonly sequence: number;
  readonly evidenceEventId: EventId;
  readonly transition: "UPDATED" | "INVALIDATED";
  readonly key: EvidenceKey;
  readonly value?: ReplayEvidenceValue;
  readonly supersedesEventId?: EventId;
  readonly invalidatesEventId?: EventId;
  readonly reason?: TextPreview;
  readonly provenance: ReplayEventProvenance;
}

export interface ReplayCurrentEvidence {
  readonly keyString: string;
  readonly key: EvidenceKey;
  readonly value: ReplayEvidenceValue;
  readonly evidenceEventId: EventId;
}

export interface ReplayVerificationHistoryEntry {
  readonly verificationRequestId: string;
  readonly verifier: string;
  readonly basis: GenerationBasis;
  readonly evidenceKey: EvidenceKey;
  readonly evidenceEventIds: readonly EventId[];
  readonly evidenceEventIdsTruncation: TruncationInfo;
  readonly candidateFormalInterpretationPersisted: boolean;
  readonly interpretationConfidence: number;
  readonly sourceGenerationId?: GenerationId;
  readonly sourceProposalRequestId?: string;
  readonly requestProvenance: ReplayEventProvenance;
  readonly status: "PENDING" | "ACCEPTED" | "DISCARDED";
  readonly result?: {
    readonly status: VerificationStatus;
    readonly verifier: string;
    readonly interpretationConfidence: number;
    readonly provenance: ReplayEventProvenance;
  };
  readonly discard?: {
    readonly reason: TextPreview;
    readonly provenance: ReplayEventProvenance;
  };
}

export interface ReplayGenerationHistoryEntry {
  readonly generationId: GenerationId;
  readonly provider: string;
  readonly basis: GenerationBasis;
  readonly startProvenance: ReplayEventProvenance;
  readonly status: "ACTIVE" | "PROPOSAL_RECEIVED" | "VALIDATED" | "REJECTED" | "SUPERSEDED" | "UNKNOWN";
  readonly contextManifest?: ReplayGenerationDetail["contextManifest"];
  readonly proposalMetadata?: {
    readonly realizedAction: SocraticAction;
    readonly claimedDisclosureLevel: DisclosureLevel;
    readonly claimedDisclosureIdCount: number;
    readonly speechTextPersisted: boolean;
    readonly boardActionCount: number;
    readonly provenance: ReplayEventProvenance;
  };
  readonly formalInterpretation?: {
    readonly proposalRequestId: string;
    readonly candidateFormalInterpretationPersisted: boolean;
    readonly provenance: ReplayEventProvenance;
  };
  readonly superseded?: {
    readonly reason: TextPreview;
    readonly provenance: ReplayEventProvenance;
  };
  readonly deliveryIds: readonly string[];
  readonly deliveryIdsTruncation: TruncationInfo;
  readonly statusIsCurrent: boolean;
}

export interface ReplayEvaluationSummary {
  readonly sessionId: SessionId;
  readonly problemId: string;
  readonly problemVersion: string;
  readonly evaluatedAt: string;
  readonly scores: {
    readonly technicalCorrectness: number;
    readonly rigor: number;
    readonly independence: number;
    readonly communication: number;
    readonly hintResponsiveness: number;
    readonly errorRecovery: number;
    readonly compositeScore: number;
  };
  readonly milestoneCount: number;
  readonly achievedMilestoneCount: number;
  readonly unassistedMilestoneCount: number;
  readonly assistedMilestoneCount: number;
  readonly disclosedInterventionCount: number;
  readonly totalTurns: number;
}

export interface ReplaySessionLifecycle {
  readonly status: "ACTIVE" | "COMPLETED" | "ARCHIVED" | "UNKNOWN";
  readonly historyComplete: boolean;
  readonly started: boolean | null;
  readonly completed: boolean | null;
  readonly archived: boolean | null;
  readonly resumedCount: number;
  readonly conservativeRecoveryCount: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly archivedAt?: string;
  readonly activeElapsedDurationMs?: number;
}

export interface ReplaySessionCounts {
  readonly turns: number;
  readonly inputEpisodes: number;
  readonly utterances: number;
  readonly generations: number;
  readonly deliveries: number;
  readonly exposedInterventions: number;
  readonly possiblyExposedInterventions: number;
  readonly cancelledInterventions: number;
  readonly inFlightDeliveries?: number;
}

export interface ReplayEvidenceSummary {
  readonly recordedUpdates: number;
  readonly recordedInvalidations: number;
  readonly currentActive?: number;
  readonly superseded?: number;
  readonly stale?: number;
}

export interface ReplayVerificationSummary {
  readonly pending: number;
  readonly verified: number;
  readonly contradicted: number;
  readonly unresolved: number;
  readonly discarded: number;
}

export interface SessionHistoryProjection {
  readonly sessionId: SessionId | null;
  readonly problem?: {
    readonly problemId: string;
    readonly problemVersion: string;
  };
  readonly lifecycle: ReplaySessionLifecycle;
  readonly counts: ReplaySessionCounts;
  readonly highestDisclosureUsed?: DisclosureLevel;
  readonly currentStateAvailable: boolean;
  readonly validatedThroughSequence: number;
  readonly knownThroughSequence: number;
  readonly countsComplete: boolean;
  readonly totalEventCount: number;
  readonly timeline: ReplayTimelineProjection;
  readonly evidenceHistory: readonly ReplayEvidenceHistoryEntry[];
  readonly evidenceHistoryTruncation: TruncationInfo;
  readonly evidenceHistoryComplete: boolean;
  readonly currentEvidence: readonly ReplayCurrentEvidence[];
  readonly currentEvidenceTruncation: TruncationInfo;
  readonly evidenceSummary: ReplayEvidenceSummary;
  readonly verificationHistory: readonly ReplayVerificationHistoryEntry[];
  readonly verificationTruncation: TruncationInfo;
  readonly verificationHistoryComplete: boolean;
  readonly verificationSummary: ReplayVerificationSummary;
  readonly generationHistory: readonly ReplayGenerationHistoryEntry[];
  readonly generationTruncation: TruncationInfo;
  readonly generationHistoryComplete: boolean;
  readonly evaluation?: ReplayEvaluationSummary;
}

export interface LongitudinalEvaluationStatistics {
  readonly problemId: string;
  readonly problemVersion: string;
  readonly sessionCount: number;
  readonly average: ReplayEvaluationSummary["scores"];
  readonly median: ReplayEvaluationSummary["scores"];
}

export interface LongitudinalImprovementRecord {
  readonly problemId: string;
  readonly problemVersion: string;
  readonly fromSessionId: SessionId;
  readonly toSessionId: SessionId;
  readonly compositeScoreDelta: number;
}

export interface LongitudinalRepeatedProblem {
  readonly problemId: string;
  readonly problemVersion: string;
  readonly attemptCount: number;
}

export interface LongitudinalEvidencePattern {
  readonly key: EvidenceKey;
  readonly sessionCount: number;
  readonly observedValues: Readonly<Record<string, number>>;
}

export interface LongitudinalHistoryProjection {
  readonly totalInputSessions: number;
  readonly includedSessionCount: number;
  readonly sessionTruncation: TruncationInfo;
  readonly completedSessions: number;
  readonly sessionsWithUnknownCompletion: number;
  readonly problemsAttempted: number;
  readonly assistanceEligibleSessionCount: number;
  readonly sessionsWithAssistance: number;
  readonly totalExposedInterventions: number;
  readonly totalPossiblyExposedInterventions: number;
  readonly sessionsExcludedFromAssistanceStatistics: number;
  readonly repeatedProblems: readonly LongitudinalRepeatedProblem[];
  readonly evaluationStatistics: readonly LongitudinalEvaluationStatistics[];
  readonly improvement: readonly LongitudinalImprovementRecord[];
  readonly improvementComparisonsSkipped: number;
  readonly evidencePatterns: readonly LongitudinalEvidencePattern[];
  readonly sessionsExcludedFromEvidencePatterns: number;
  readonly sessionsWithIncompleteProjection: number;
  readonly comparability: {
    readonly problems: "EXACT_PROBLEM_ID_AND_VERSION";
    readonly evidence: "EXACT_EVIDENCE_KEY_ONLY";
    readonly skillTaxonomyAvailable: false;
  };
  readonly bounds: ReplayBounds;
}
