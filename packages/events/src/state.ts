import type {
  BoardRevision,
  ContextEpoch,
  ContextCompilationManifest,
  DeliveryAtom,
  DisclosureId,
  EvidenceProposal,
  EvidenceValue,
  EventId,
  FormalInterpretationProposal,
  GenerationBasis,
  GenerationId,
  InputEpisodeId,
  InterviewerProposal,
  PolicyRevision,
  ProviderContextSpecFingerprint,
  ProblemStateRevision,
  RealizationRequest,
  SessionId,
  TranscriptRevision,
  TurnId,
  UtteranceId,
  BoardObservation,
  RequestId,
  VerificationResult,
  EvidenceKey
} from "../../domain/src/index.js";
import {
  zeroBoardRevision,
  zeroContextEpoch,
  zeroPolicyRevision,
  zeroProblemStateRevision,
  zeroTranscriptRevision
} from "../../domain/src/index.js";

export interface InputEpisodeState {
  readonly inputEpisodeId: InputEpisodeId;
  readonly status: "ACTIVE" | "COMMITTED";
  readonly inputs: readonly { readonly modality: "SPEECH" | "TYPING" | "WHITEBOARD"; readonly semanticContent: string }[];
}
export interface TurnState {
  readonly turnId: TurnId;
  readonly inputEpisodeId: InputEpisodeId;
  readonly studentText: string;
  readonly committedSequence: number;
}
export interface UtteranceState {
  readonly utteranceId: UtteranceId;
  readonly status: "CAPTURING" | "DISCARDED" | "FINALIZED";
  readonly inputEpisodeId?: InputEpisodeId;
  readonly text?: string;
}
export interface VisionRequestState {
  readonly visionRequestId: RequestId;
  readonly sourceBoardRevision: BoardRevision;
  readonly regionId: string;
  readonly relevantShapeIds: readonly string[];
  readonly status: "PENDING" | "ACCEPTED" | "DISCARDED";
  readonly observation?: BoardObservation;
  readonly discardReason?: string;
}
export interface LocalComputeRequestState {
  readonly computeRequestId: RequestId;
  readonly operation: "ANALYZE_TRANSCRIPT";
  readonly inputEpisodeId: InputEpisodeId;
  readonly sourceTranscriptRevision: TranscriptRevision;
  readonly status: "PENDING" | "ACCEPTED" | "DISCARDED";
  readonly result?: {
    readonly normalizedText: string;
    readonly tokenCount: number;
  };
  readonly discardReason?: string;
}
export interface VerificationRequestState {
  readonly verificationRequestId: RequestId;
  readonly verifier: string;
  readonly basis: GenerationBasis;
  readonly candidateFormalInterpretation: string;
  readonly interpretationConfidence: number;
  readonly evidenceKey: EvidenceKey;
  readonly evidenceEventIds: readonly EventId[];
  readonly sourceGenerationId?: GenerationId | undefined;
  readonly sourceProposalRequestId?: RequestId | undefined;
  readonly requestedEventId: EventId;
  readonly status: "PENDING" | "ACCEPTED" | "DISCARDED";
  readonly result?: VerificationResult;
  readonly resultEventId?: EventId;
  readonly resultSequence?: number;
  readonly discardReason?: string;
}
export interface EvidenceRecordState {
  readonly evidenceEventId: EventId;
  readonly key: EvidenceKey;
  readonly value: EvidenceValue;
  readonly status: "ACTIVE" | "SUPERSEDED" | "STALE";
  readonly supersededByEventId?: EventId;
  readonly invalidationReason?: string;
}
export interface GenerationState {
  readonly generationId: GenerationId;
  readonly basis: GenerationBasis;
  readonly provider: string;
  /** Derived during replay from the application-selected action that existed when generation began. */
  readonly pedagogicalAction?: RealizationRequest;
  /** Derived from PROPOSAL_VALIDATED and preserved through later supersession. */
  readonly interviewerProposalValidated?: true;
  readonly status: "ACTIVE" | "PROPOSAL_RECEIVED" | "VALIDATED" | "REJECTED" | "SUPERSEDED";
  readonly contextManifest?: ContextCompilationManifest;
  readonly proposal?: InterviewerProposal;
  readonly formalInterpretationProposal?: FormalInterpretationProposal;
}
export interface SessionState {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly started: boolean;
  readonly status: "CREATED" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
  readonly completedAt?: string | undefined;
  readonly archivedAt?: string | undefined;
  readonly completionSummary?: string | undefined;
  readonly archivalReason?: string | undefined;
  readonly problem?: {
    readonly id: string;
    readonly version: string;
    readonly prompt: string;
    readonly providerContextSpecSha256?: ProviderContextSpecFingerprint;
  };
  readonly contextEpoch: ContextEpoch;
  readonly transcriptRevision: TranscriptRevision;
  readonly boardRevision: BoardRevision;
  readonly problemStateRevision: ProblemStateRevision;
  readonly policyRevision: PolicyRevision;
  readonly lastCommittedInputSequence?: number;
  readonly eventIds: readonly EventId[];
  readonly utterances: Readonly<Record<string, UtteranceState>>;
  readonly inputEpisodes: Readonly<Record<string, InputEpisodeState>>;
  readonly turns: Readonly<Record<string, TurnState>>;
  readonly generations: Readonly<Record<string, GenerationState>>;
  readonly pedagogicalActions: Readonly<Record<string, RealizationRequest>>;
  readonly deliveries: Readonly<Record<string, DeliveryAtom>>;
  readonly disclosureLedger: readonly DisclosureId[];
  readonly visionRequests: Readonly<Record<string, VisionRequestState>>;
  readonly localComputeRequests: Readonly<Record<string, LocalComputeRequestState>>;
  readonly verificationRequests: Readonly<Record<string, VerificationRequestState>>;
  readonly evidenceProposals: readonly EvidenceProposal[];
  readonly studentEvidence: Readonly<Record<string, EvidenceValue>>;
  readonly evidenceHistory: Readonly<Record<string, readonly EvidenceRecordState[]>>;
}

export const initialSessionState = (sessionId: SessionId): SessionState => ({
  sessionId,
  sequence: 0,
  started: false,
  status: "CREATED",
  contextEpoch: zeroContextEpoch,
  transcriptRevision: zeroTranscriptRevision,
  boardRevision: zeroBoardRevision,
  problemStateRevision: zeroProblemStateRevision,
  policyRevision: zeroPolicyRevision,
  eventIds: [],
  utterances: {},
  inputEpisodes: {},
  turns: {},
  generations: {},
  pedagogicalActions: {},
  deliveries: {},
  disclosureLedger: [],
  visionRequests: {},
  localComputeRequests: {},
  verificationRequests: {},
  evidenceProposals: [],
  studentEvidence: {},
  evidenceHistory: {}
});
