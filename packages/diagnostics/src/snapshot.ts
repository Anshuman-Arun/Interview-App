import { Buffer } from "node:buffer";
import process from "node:process";
import { z } from "zod";
import { fingerprintDiagnosticConfiguration } from "./fingerprint.js";
import {
  DIAGNOSTIC_SANITIZATION_LIMITS,
  sanitizeDiagnosticRecord,
  sanitizeDiagnosticValue
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
export const MAX_SNAPSHOT_TIMINGS = 1_000;
export const MAX_SNAPSHOT_HEALTH_OBSERVATIONS = 256;
export const MAX_SERIALIZED_DIAGNOSTIC_SNAPSHOT_BYTES = 4_000_000;
const MAX_SNAPSHOT_TIMING_BYTES = 2_000_000;
const MAX_SNAPSHOT_AGGREGATE_BYTES = 500_000;
const MAX_SNAPSHOT_HEALTH_BYTES = 500_000;

export const DiagnosticSnapshotSchema = z.object({
  schemaVersion: z.literal(DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  runtime: RuntimeFingerprintSchema,
  timings: z.array(OperationTimingSchema).max(MAX_SNAPSHOT_TIMINGS),
  timingAggregates: z.array(TimingAggregateSchema).max(MAX_SNAPSHOT_TIMINGS),
  health: z.array(SubsystemHealthSchema).max(MAX_SNAPSHOT_HEALTH_OBSERVATIONS),
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
  const rawFingerprint = {
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
      : { verifiers: input.verifiers
          .slice(-DIAGNOSTIC_SANITIZATION_LIMITS.maxArrayItems)
          .map((item) => RuntimeComponentMetadataSchema.parse(item)) }),
    ...(input.workers === undefined
      ? {}
      : { workers: input.workers
          .slice(-DIAGNOSTIC_SANITIZATION_LIMITS.maxArrayItems)
          .map((item) => RuntimeComponentMetadataSchema.parse(item)) })
  };
  return RuntimeFingerprintSchema.parse(sanitizeDiagnosticValue(rawFingerprint));
}

function sanitizeTiming(sample: OperationTiming): OperationTiming {
  return OperationTimingSchema.parse(sanitizeDiagnosticValue(sample));
}

function sanitizeHealth(status: SubsystemHealth): SubsystemHealth {
  return SubsystemHealthSchema.parse(sanitizeDiagnosticValue(status));
}

function deepFreezeParsed(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) deepFreezeParsed(child, seen);
  Object.freeze(value);
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sanitizeRecentWithinBudget<TInput, TOutput>(
  values: readonly TInput[],
  maxItems: number,
  maxBytes: number,
  sanitize: (value: TInput) => TOutput
): readonly TOutput[] {
  const output: TOutput[] = [];
  let usedBytes = 0;
  const start = Math.max(0, values.length - maxItems);
  for (let index = values.length - 1; index >= start; index -= 1) {
    const value = values[index];
    if (value === undefined) continue;
    const sanitized = sanitize(value);
    const itemBytes = jsonByteLength(sanitized);
    if (usedBytes + itemBytes > maxBytes) break;
    output.unshift(sanitized);
    usedBytes += itemBytes;
  }
  return output;
}

function sanitizeAllWithinBudget<TInput, TOutput>(
  values: readonly TInput[],
  maxBytes: number,
  label: string,
  sanitize: (value: TInput) => TOutput
): readonly TOutput[] {
  const output: TOutput[] = [];
  let usedBytes = 0;
  for (const value of values) {
    const sanitized = sanitize(value);
    usedBytes += jsonByteLength(sanitized);
    if (usedBytes > maxBytes) {
      throw new RangeError(`Diagnostic snapshot ${label} exceeds its byte limit`);
    }
    output.push(sanitized);
  }
  return output;
}

export function createDiagnosticSnapshot(input: CreateDiagnosticSnapshotInput): DiagnosticSnapshot {
  const timings = sanitizeRecentWithinBudget(
    input.timings ?? [],
    MAX_SNAPSHOT_TIMINGS,
    MAX_SNAPSHOT_TIMING_BYTES,
    sanitizeTiming
  );
  const health = sanitizeRecentWithinBudget(
    input.health ?? [],
    MAX_SNAPSHOT_HEALTH_OBSERVATIONS,
    MAX_SNAPSHOT_HEALTH_BYTES,
    sanitizeHealth
  );
  const generatedAt = input.generatedAt instanceof Date
    ? input.generatedAt.toISOString()
    : input.generatedAt ?? new Date().toISOString();
  const extra: DiagnosticRecord | undefined = input.extra === undefined
    ? undefined
    : sanitizeDiagnosticRecord(input.extra);

  const snapshot = DiagnosticSnapshotSchema.parse({
    schemaVersion: DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    runtime: RuntimeFingerprintSchema.parse(sanitizeDiagnosticValue(input.runtime)),
    timings,
    timingAggregates: aggregateTimings(timings),
    health,
    ...(extra === undefined ? {} : { extra })
  });
  deepFreezeParsed(snapshot);
  return snapshot;
}

export function serializeDiagnosticSnapshot(snapshot: DiagnosticSnapshot, space = 2): string {
  if (!Number.isSafeInteger(space) || space < 0 || space > 10) {
    throw new RangeError("Diagnostic snapshot indentation must be an integer from 0 through 10");
  }
  const sanitizedTimings = sanitizeAllWithinBudget(
    snapshot.timings,
    MAX_SNAPSHOT_TIMING_BYTES,
    "timings",
    sanitizeTiming
  );
  const sanitizedAggregates = sanitizeAllWithinBudget(
    snapshot.timingAggregates,
    MAX_SNAPSHOT_AGGREGATE_BYTES,
    "timing aggregates",
    (aggregate) => TimingAggregateSchema.parse(sanitizeDiagnosticValue(aggregate))
  );
  const sanitizedHealth = sanitizeAllWithinBudget(
    snapshot.health,
    MAX_SNAPSHOT_HEALTH_BYTES,
    "health observations",
    sanitizeHealth
  );
  const sanitizedSnapshot = DiagnosticSnapshotSchema.parse({
    schemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.generatedAt,
    runtime: RuntimeFingerprintSchema.parse(sanitizeDiagnosticValue(snapshot.runtime)),
    timings: sanitizedTimings,
    timingAggregates: sanitizedAggregates,
    health: sanitizedHealth,
    ...(snapshot.extra === undefined ? {} : { extra: sanitizeDiagnosticRecord(snapshot.extra) })
  });
  const serialized = JSON.stringify(sanitizedSnapshot, null, space);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_DIAGNOSTIC_SNAPSHOT_BYTES) {
    throw new RangeError("Serialized diagnostic snapshot exceeds its byte limit");
  }
  return serialized;
}
