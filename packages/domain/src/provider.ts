import { z } from "zod";
import type { GenerationId } from "./ids.js";
import { GenerationIdSchema } from "./ids.js";
import type { BoardObservation } from "./whiteboard.js";
import type { InterviewerProposal } from "./proposal.js";

export const CancellationCapabilitySchema = z.enum([
  "NONE", "DROP_OUTPUT", "CLOSE_CLIENT_STREAM", "CANCEL_PROVIDER_COMPUTE", "INTERRUPT_LOCAL_PROCESS"
]);
export type CancellationCapability = z.infer<typeof CancellationCapabilitySchema>;
export const DataUsePolicySchema = z.enum(["LOCAL_ONLY", "REMOTE_NO_TRAINING", "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT"]);
export type DataUsePolicy = z.infer<typeof DataUsePolicySchema>;
export const StructuredOutputCapabilitySchema = z.enum(["NONE", "FINAL_ONLY", "STREAMING"]);
export type StructuredOutputCapability = z.infer<typeof StructuredOutputCapabilitySchema>;

export const ModelCapabilitiesSchema = z.object({
  inputModalities: z.set(z.enum(["text", "image"])).min(1),
  textStreaming: z.boolean(),
  structuredOutput: StructuredOutputCapabilitySchema,
  persistentSession: z.boolean(),
  resumableSession: z.boolean(),
  cancellation: CancellationCapabilitySchema,
  sessionSurvivesClientAbort: z.boolean(),
  sessionSurvivesProviderCancel: z.boolean(),
  usageReporting: z.boolean(),
  reasoningLevels: z.array(z.string().min(1)).optional(),
  dataUse: DataUsePolicySchema
}).strict();
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ProviderCancellationResultSchema = z.discriminatedUnion("semantics", [
  z.object({ semantics: z.literal("NONE") }).strict(),
  z.object({ semantics: z.literal("DROP_OUTPUT") }).strict(),
  z.object({ semantics: z.literal("CLOSE_CLIENT_STREAM"), streamClosed: z.boolean() }).strict(),
  z.object({ semantics: z.literal("CANCEL_PROVIDER_COMPUTE"), providerConfirmed: z.boolean() }).strict(),
  z.object({ semantics: z.literal("INTERRUPT_LOCAL_PROCESS"), signalSent: z.boolean() }).strict()
]);
export type ProviderCancellationResult = z.infer<typeof ProviderCancellationResultSchema>;

export const ProviderCancellationReportSchema = z.object({
  generationId: GenerationIdSchema,
  outputDisposition: z.literal("DROP_OUTPUT"),
  adapterResult: ProviderCancellationResultSchema
}).strict();
export type ProviderCancellationReport = z.infer<typeof ProviderCancellationReportSchema>;

export interface ReasoningTurnInput {
  readonly context: unknown;
  readonly generationId: GenerationId;
}
export interface ReasoningSession {
  readonly sendTurn: (input: ReasoningTurnInput) => AsyncIterable<InterviewerProposal>;
  readonly cancelTurn?: (generationId: GenerationId) => Promise<ProviderCancellationResult>;
  readonly close: () => Promise<void>;
}
export interface ReasoningProvider {
  readonly name: string;
  readonly adapterVersion: string;
  readonly capabilities: ModelCapabilities;
  readonly verifyBillingSafety: (input: { readonly now: Date }) => Promise<unknown>;
  readonly createSession: () => Promise<ReasoningSession>;
}
export interface VisionProvider {
  readonly name: string;
  readonly observe: (request: { readonly imageRef: string; readonly sourceBoardRevision: number }) => Promise<BoardObservation>;
}
