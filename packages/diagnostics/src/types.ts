import { z } from "zod";
import {
  ModelCapabilitiesSchema,
  type ModelCapabilities
} from "../../domain/src/index.js";

export type DiagnosticPrimitive = string | number | boolean | null;
export type DiagnosticValue =
  | DiagnosticPrimitive
  | readonly DiagnosticValue[]
  | DiagnosticRecord;
export interface DiagnosticRecord {
  readonly [key: string]: DiagnosticValue;
}

export const DiagnosticValueSchema: z.ZodType<DiagnosticValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(DiagnosticValueSchema),
    z.record(z.string(), DiagnosticValueSchema)
  ])
);
export const DiagnosticRecordSchema: z.ZodType<DiagnosticRecord> = z.record(
  z.string(),
  DiagnosticValueSchema
);

export const Sha256FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export type Sha256Fingerprint = z.infer<typeof Sha256FingerprintSchema>;

export const RuntimeComponentMetadataSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).optional()
}).strict();
export type RuntimeComponentMetadata = z.infer<typeof RuntimeComponentMetadataSchema>;

export const ProviderCapabilitiesDiagnosticSchema = z.object({
  inputModalities: z.array(z.enum(["text", "image"])).min(1),
  textStreaming: z.boolean(),
  structuredOutput: z.enum(["NONE", "FINAL_ONLY", "STREAMING"]),
  persistentSession: z.boolean(),
  resumableSession: z.boolean(),
  cancellation: z.enum([
    "NONE",
    "DROP_OUTPUT",
    "CLOSE_CLIENT_STREAM",
    "CANCEL_PROVIDER_COMPUTE",
    "INTERRUPT_LOCAL_PROCESS"
  ]),
  sessionSurvivesClientAbort: z.boolean(),
  sessionSurvivesProviderCancel: z.boolean(),
  usageReporting: z.boolean(),
  reasoningLevels: z.array(z.string().min(1)).optional(),
  dataUse: z.enum([
    "LOCAL_ONLY",
    "REMOTE_NO_TRAINING",
    "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT"
  ])
}).strict();
export type ProviderCapabilitiesDiagnostic = z.infer<typeof ProviderCapabilitiesDiagnosticSchema>;

export const ProviderRuntimeMetadataSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  adapterVersion: z.string().min(1).optional(),
  capabilities: ProviderCapabilitiesDiagnosticSchema.optional()
}).strict();
export type ProviderRuntimeMetadata = z.infer<typeof ProviderRuntimeMetadataSchema>;

export const ProblemRuntimeMetadataSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1).optional(),
  sha256: Sha256FingerprintSchema.optional()
}).strict();
export type ProblemRuntimeMetadata = z.infer<typeof ProblemRuntimeMetadataSchema>;

export const RuntimeEnvironmentSchema = z.object({
  platform: z.string().min(1),
  architecture: z.string().min(1),
  nodeVersion: z.string().min(1),
  pythonVersion: z.string().min(1).optional()
}).strict();
export type RuntimeEnvironment = z.infer<typeof RuntimeEnvironmentSchema>;

export const RuntimeFingerprintSchema = z.object({
  applicationVersion: z.string().min(1).optional(),
  buildCommitSha: z.string().regex(/^[0-9a-f]{7,64}$/iu).optional(),
  runtime: RuntimeEnvironmentSchema,
  eventSchemaVersion: z.number().int().positive().optional(),
  configurationSha256: Sha256FingerprintSchema.optional(),
  problem: ProblemRuntimeMetadataSchema.optional(),
  provider: ProviderRuntimeMetadataSchema.optional(),
  verifiers: z.array(RuntimeComponentMetadataSchema).optional(),
  workers: z.array(RuntimeComponentMetadataSchema).optional()
}).strict();
export type RuntimeFingerprint = z.infer<typeof RuntimeFingerprintSchema>;

export const SubsystemHealthStateSchema = z.enum([
  "HEALTHY",
  "DEGRADED",
  "UNAVAILABLE",
  "UNKNOWN"
]);
export type SubsystemHealthState = z.infer<typeof SubsystemHealthStateSchema>;

export const DiagnosticSubsystemSchema = z.enum([
  "PERSISTENCE",
  "PROVIDER",
  "VERIFIER",
  "LOCAL_WORKER",
  "RENDERER",
  "WHITEBOARD",
  "STT",
  "TTS",
  "VISION",
  "OTHER"
]);
export type DiagnosticSubsystem = z.infer<typeof DiagnosticSubsystemSchema>;

export const SubsystemHealthSchema = z.object({
  subsystem: DiagnosticSubsystemSchema,
  componentId: z.string().min(1).optional(),
  state: SubsystemHealthStateSchema,
  observedAt: z.iso.datetime().optional(),
  detail: z.string().min(1).max(2_000).optional(),
  metadata: DiagnosticRecordSchema.optional()
}).strict();
export type SubsystemHealth = z.infer<typeof SubsystemHealthSchema>;

export function toDiagnosticProviderCapabilities(
  capabilities: ModelCapabilities
): ProviderCapabilitiesDiagnostic {
  const parsed = ModelCapabilitiesSchema.parse(capabilities);
  return ProviderCapabilitiesDiagnosticSchema.parse({
    inputModalities: [...parsed.inputModalities].sort(),
    textStreaming: parsed.textStreaming,
    structuredOutput: parsed.structuredOutput,
    persistentSession: parsed.persistentSession,
    resumableSession: parsed.resumableSession,
    cancellation: parsed.cancellation,
    sessionSurvivesClientAbort: parsed.sessionSurvivesClientAbort,
    sessionSurvivesProviderCancel: parsed.sessionSurvivesProviderCancel,
    usageReporting: parsed.usageReporting,
    ...(parsed.reasoningLevels === undefined
      ? {}
      : { reasoningLevels: [...parsed.reasoningLevels].sort() }),
    dataUse: parsed.dataUse
  });
}
