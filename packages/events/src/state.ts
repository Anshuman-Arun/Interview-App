import type {
  BoardRevision,
  ContextEpoch,
  DeliveryAtom,
  DisclosureId,
  GenerationBasis,
  GenerationId,
  InputEpisodeId,
  InterviewerProposal,
  PolicyRevision,
  ProblemStateRevision,
  RealizationRequest,
  SessionId,
  TranscriptRevision,
  TurnId
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
export interface GenerationState {
  readonly generationId: GenerationId;
  readonly basis: GenerationBasis;
  readonly provider: string;
  readonly status: "ACTIVE" | "PROPOSAL_RECEIVED" | "VALIDATED" | "REJECTED" | "SUPERSEDED";
  readonly proposal?: InterviewerProposal;
}
export interface SessionState {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly started: boolean;
  readonly problem?: { readonly id: string; readonly version: string; readonly prompt: string };
  readonly contextEpoch: ContextEpoch;
  readonly transcriptRevision: TranscriptRevision;
  readonly boardRevision: BoardRevision;
  readonly problemStateRevision: ProblemStateRevision;
  readonly policyRevision: PolicyRevision;
  readonly lastCommittedInputSequence?: number;
  readonly inputEpisodes: Readonly<Record<string, InputEpisodeState>>;
  readonly turns: Readonly<Record<string, TurnState>>;
  readonly generations: Readonly<Record<string, GenerationState>>;
  readonly pedagogicalActions: Readonly<Record<string, RealizationRequest>>;
  readonly deliveries: Readonly<Record<string, DeliveryAtom>>;
  readonly disclosureLedger: readonly DisclosureId[];
}

export const initialSessionState = (sessionId: SessionId): SessionState => ({
  sessionId,
  sequence: 0,
  started: false,
  contextEpoch: zeroContextEpoch,
  transcriptRevision: zeroTranscriptRevision,
  boardRevision: zeroBoardRevision,
  problemStateRevision: zeroProblemStateRevision,
  policyRevision: zeroPolicyRevision,
  inputEpisodes: {},
  turns: {},
  generations: {},
  pedagogicalActions: {},
  deliveries: {},
  disclosureLedger: []
});

