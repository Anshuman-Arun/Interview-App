import type { GenerationId } from "./ids.js";
import type { BoardObservation } from "./whiteboard.js";
import type { InterviewerProposal } from "./proposal.js";

export type CancellationCapability =
  | "NONE" | "DROP_OUTPUT" | "CLOSE_CLIENT_STREAM" | "CANCEL_PROVIDER_COMPUTE" | "INTERRUPT_LOCAL_PROCESS";
export type DataUsePolicy = "LOCAL_ONLY" | "REMOTE_NO_TRAINING" | "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT";
export type StructuredOutputCapability = "NONE" | "FINAL_ONLY" | "STREAMING";

export interface ModelCapabilities {
  readonly inputModalities: ReadonlySet<"text" | "image">;
  readonly textStreaming: boolean;
  readonly structuredOutput: StructuredOutputCapability;
  readonly persistentSession: boolean;
  readonly resumableSession: boolean;
  readonly cancellation: CancellationCapability;
  readonly sessionSurvivesClientAbort: boolean;
  readonly sessionSurvivesProviderCancel: boolean;
  readonly usageReporting: boolean;
  readonly reasoningLevels?: readonly string[];
  readonly dataUse: DataUsePolicy;
}

export interface ReasoningTurnInput {
  readonly context: unknown;
  readonly generationId: GenerationId;
}
export interface ReasoningSession {
  readonly sendTurn: (input: ReasoningTurnInput) => AsyncIterable<InterviewerProposal>;
  readonly cancelTurn?: (generationId: GenerationId) => Promise<void>;
  readonly close: () => Promise<void>;
}
export interface ReasoningProvider {
  readonly name: string;
  readonly adapterVersion: string;
  readonly capabilities: ModelCapabilities;
  readonly createSession: () => Promise<ReasoningSession>;
}
export interface VisionProvider {
  readonly name: string;
  readonly observe: (request: { readonly imageRef: string; readonly sourceBoardRevision: number }) => Promise<BoardObservation>;
}

