import process from "node:process";
import { z } from "zod";
import { fingerprintDiagnosticConfiguration } from "./fingerprint.js";
import {
  sanitizeDiagnosticRecord,
  sanitizeDiagnosticText
} from "./sanitize.js";
import {
  aggregateTimings,
  OperationTimingSchema,
  TimingAggregateSchema,
  type OperationTiming
} from "./timing.js";
import {
  DiagnosticRecordSchema,
  ProblemRuntimeMetadataSchema,
  ProviderRuntimeMetadataSchema,
  RuntimeComponentMetadataSchema,
  RuntimeFingerprintSchema,
  SubsystemHealthSchema,
  type DiagnosticRecord,
  type ProblemRuntimeMetadata,
  type ProviderRuntimeMetadata,
  type RuntimeComponentMetadata,
  type RuntimeFingerprint,
  type SubsystemHealth
} from "./types.js";

export const DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const DiagnosticSnapshotSchema = z.object({
  schemaVersion: z.literal(DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  runtime: RuntimeFingerprintSchema,
  timings: z.array(OperationTimingSchema),
  timingAggregates: z.array(TimingAggregateSchema),
  health: z.array(SubsystemHealthSchema),
  extra: DiagnosticRecordSchema.optional()
}).strict();
export type DiagnosticSnapshot = z.infer<typeof DiagnosticSnapshotSchema>;

export interface CaptureRuntimeFingerprintInput {
  readonly applicationVersion?: string;
  readonly buildCommitSha?: string;
  readonly pythonVersion?: string;
  readonly eventSchemaVersion?: number;
  readonly configuration?: unknown;
  readonly problem?: ProblemRuntimeMetadata;
  readonly provider?: ProviderRuntimeMetadata;
  readonly verifiers?: readonly RuntimeComponentMetadata[];
  readonly workers?: readonly RuntimeComponentMetadata[];
}

export interface CreateDiagnosticSnapshotInput {
  readonly runtime: RuntimeFingerprint;
  readonly timings?: readonly OperationTiming[];
  readonly health?: readonly SubsystemHealth[];
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly generatedAt?: Date | string;
}

export function captureRuntimeFingerprint(
  input: CaptureRuntimeFingerprintInput = {}
): RuntimeFingerprint {
  return RuntimeFingerprintSchema.parse({
    ...(input.applicationVersion === undefined ? {} : { applicationVersion: input.applicationVersion }),
    ...(input.buildCommitSha === undefined ? {} : { buildCommitSha: input.buildCommitSha }),
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      ...(input.pythonVersion === undefined ? {} : { pythonVersion: input.pythonVersion })
    },
    ...(input.eventSchemaVersion === undefined ? {} : { eventSchemaVersion: input.eventSchemaVersion }),
    ...(input.configuration === undefined
      ? {}
      : { configurationSha256: fingerprintDiagnosticConfiguration(input.configuration) }),
    ...(input.problem === undefined ? {} : { problem: ProblemRuntimeMetadataSchema.parse(input.problem) }),
    ...(input.provider === undefined ? {} : { provider: ProviderRuntimeMetadataSchema.parse(input.provider) }),
    ...(input.verifiers === undefined
      ? {}
      : { verifiers: input.verifiers.map((item) => RuntimeComponentMetadataSchema.parse(item)) }),
    ...(input.workers === undefined
      ? {}
      : { workers: input.workers.map((item) => RuntimeComponentMetadataSchema.parse(item)) })
  });
}

function sanitizeTiming(sample: OperationTiming): OperationTiming {
  return OperationTimingSchema.parse({
    ...sample,
    ...(sample.tags === undefined ? {} : { tags: sanitizeDiagnosticRecord(sample.tags) })
  });
}

function sanitizeHealth(status: SubsystemHealth): SubsystemHealth {
  return SubsystemHealthSchema.parse({
    ...status,
    ...(status.detail === undefined ? {} : { detail: sanitizeDiagnosticText(status.detail) }),
    ...(status.metadata === undefined ? {} : { metadata: sanitizeDiagnosticRecord(status.metadata) })
  });
}

export function createDiagnosticSnapshot(input: CreateDiagnosticSnapshotInput): DiagnosticSnapshot {
  const timings = (input.timings ?? []).map((sample) => sanitizeTiming(sample));
  const health = (input.health ?? []).map((status) => sanitizeHealth(status));
  const generatedAt = input.generatedAt instanceof Date
    ? input.generatedAt.toISOString()
    : input.generatedAt ?? new Date().toISOString();
  const extra: DiagnosticRecord | undefined = input.extra === undefined
    ? undefined
    : sanitizeDiagnosticRecord(input.extra);

  return Object.freeze(DiagnosticSnapshotSchema.parse({
    schemaVersion: DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    runtime: RuntimeFingerprintSchema.parse(input.runtime),
    timings,
    timingAggregates: aggregateTimings(timings),
    health,
    ...(extra === undefined ? {} : { extra })
  }));
}

export function serializeDiagnosticSnapshot(snapshot: DiagnosticSnapshot, space = 2): string {
  return JSON.stringify(DiagnosticSnapshotSchema.parse(snapshot), null, space);
}
