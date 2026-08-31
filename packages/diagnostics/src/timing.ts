import { z } from "zod";
import {
  DIAGNOSTIC_SANITIZATION_LIMITS,
  sanitizeDiagnosticRecord,
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue
} from "./sanitize.js";
import { DiagnosticRecordSchema, type DiagnosticRecord } from "./types.js";

export const TimingOperationCategorySchema = z.enum([
  "CONTEXT_COMPILATION",
  "PROVIDER_REQUEST",
  "VERIFICATION",
  "LOCAL_WORKER",
  "DELIVERY",
  "STT",
  "TTS",
  "VISION",
  "OTHER"
]);
export type TimingOperationCategory = z.infer<typeof TimingOperationCategorySchema>;

export const TimingOutcomeSchema = z.enum(["SUCCESS", "FAILURE", "CANCELLED"]);
export type TimingOutcome = z.infer<typeof TimingOutcomeSchema>;

export const OperationTimingSchema = z.object({
  operation: z.string().min(1).max(DIAGNOSTIC_SANITIZATION_LIMITS.maxKeyLength),
  category: TimingOperationCategorySchema,
  elapsedMs: z.number().nonnegative(),
  outcome: TimingOutcomeSchema,
  tags: DiagnosticRecordSchema.optional()
}).strict();
export type OperationTiming = z.infer<typeof OperationTimingSchema>;

export const TimingAggregateSchema = z.object({
  operation: z.string().min(1).max(DIAGNOSTIC_SANITIZATION_LIMITS.maxKeyLength),
  category: TimingOperationCategorySchema,
  count: z.number().int().positive(),
  minMs: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
  meanMs: z.number().nonnegative(),
  p50Ms: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  outcomes: z.object({
    SUCCESS: z.number().int().nonnegative(),
    FAILURE: z.number().int().nonnegative(),
    CANCELLED: z.number().int().nonnegative()
  }).strict()
}).strict();
export type TimingAggregate = z.infer<typeof TimingAggregateSchema>;

export interface TimingSpan {
  finish(outcome?: TimingOutcome, tags?: Readonly<Record<string, unknown>>): OperationTiming;
}

export interface TimingRecorderOptions {
  readonly now?: () => number;
  readonly maxSamples?: number;
}

export const DEFAULT_MAX_TIMING_SAMPLES = 1_000;
export const MAX_TIMING_SAMPLES = 10_000;

function cloneTiming(sample: OperationTiming): OperationTiming {
  return Object.freeze({
    operation: sample.operation,
    category: sample.category,
    elapsedMs: sample.elapsedMs,
    outcome: sample.outcome,
    ...(sample.tags === undefined ? {} : { tags: sanitizeDiagnosticRecord(sample.tags) })
  });
}

function sanitizeTiming(sample: OperationTiming): OperationTiming {
  return OperationTimingSchema.parse(sanitizeDiagnosticValue(sample));
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function aggregateTimings(samples: readonly OperationTiming[]): readonly TimingAggregate[] {
  if (samples.length > MAX_TIMING_SAMPLES) {
    throw new RangeError(`Timing aggregation accepts at most ${String(MAX_TIMING_SAMPLES)} samples`);
  }
  const groups = new Map<string, OperationTiming[]>();
  for (const rawSample of samples) {
    const sample = sanitizeTiming(rawSample);
    const key = `${sample.category}\u0000${sample.operation}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [sample]);
    else group.push(sample);
  }

  return Object.freeze(
    [...groups.values()]
      .map((group) => {
        const first = group[0];
        if (first === undefined) throw new Error("Timing aggregation group unexpectedly empty");
        const sorted = group.map((sample) => sample.elapsedMs).sort((left, right) => left - right);
        const total = sorted.reduce((sum, value) => sum + value, 0);
        const aggregate = TimingAggregateSchema.parse({
          operation: first.operation,
          category: first.category,
          count: sorted.length,
          minMs: sorted[0] ?? 0,
          maxMs: sorted.at(-1) ?? 0,
          meanMs: total / sorted.length,
          p50Ms: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95),
          outcomes: {
            SUCCESS: group.filter((sample) => sample.outcome === "SUCCESS").length,
            FAILURE: group.filter((sample) => sample.outcome === "FAILURE").length,
            CANCELLED: group.filter((sample) => sample.outcome === "CANCELLED").length
          }
        });
        return Object.freeze(aggregate);
      })
      .sort((left, right) => compareCodeUnits(left.category, right.category)
        || compareCodeUnits(left.operation, right.operation))
  );
}

export class TimingRecorder {
  readonly #now: () => number;
  readonly #maxSamples: number;
  readonly #samples: OperationTiming[] = [];
  #droppedSampleCount = 0;

  public constructor(options: TimingRecorderOptions = {}) {
    this.#now = options.now ?? (() => globalThis.performance.now());
    const maxSamples = options.maxSamples ?? DEFAULT_MAX_TIMING_SAMPLES;
    if (!Number.isSafeInteger(maxSamples) || maxSamples < 1 || maxSamples > MAX_TIMING_SAMPLES) {
      throw new RangeError(`maxSamples must be an integer between 1 and ${String(MAX_TIMING_SAMPLES)}`);
    }
    this.#maxSamples = maxSamples;
  }

  public start(
    operation: string,
    category: TimingOperationCategory,
    tags?: Readonly<Record<string, unknown>>
  ): TimingSpan {
    const safeCategory = TimingOperationCategorySchema.parse(category);
    const safeOperation = sanitizeDiagnosticText(
      operation,
      DIAGNOSTIC_SANITIZATION_LIMITS.maxKeyLength
    );
    if (safeOperation.length === 0) throw new Error("Timing operation must be non-empty");
    const startedAt = this.#now();
    const initialTags = tags === undefined ? undefined : sanitizeDiagnosticRecord(tags);
    let finished = false;

    return Object.freeze({
      finish: (
        outcome: TimingOutcome = "SUCCESS",
        finishTags?: Readonly<Record<string, unknown>>
      ): OperationTiming => {
        if (finished) throw new Error("Timing span has already been finished");
        finished = true;

        const elapsedMs = Math.max(0, this.#now() - startedAt);
        const mergedTags: DiagnosticRecord | undefined = initialTags === undefined && finishTags === undefined
          ? undefined
          : sanitizeDiagnosticRecord({
              ...(initialTags ?? {}),
              ...(finishTags ?? {})
            });
        const parsed = OperationTimingSchema.parse({
          operation: safeOperation,
          category: safeCategory,
          elapsedMs,
          outcome,
          ...(mergedTags === undefined ? {} : { tags: mergedTags })
        });
        const sample = cloneTiming(sanitizeTiming(parsed));
        if (this.#samples.length === this.#maxSamples) {
          this.#samples.shift();
          this.#droppedSampleCount += 1;
        }
        this.#samples.push(sample);
        return sample;
      }
    });
  }

  public getSamples(): readonly OperationTiming[] {
    return Object.freeze(this.#samples.map((sample) => cloneTiming(sample)));
  }

  public aggregate(): readonly TimingAggregate[] {
    return aggregateTimings(this.#samples);
  }

  public getDroppedSampleCount(): number {
    return this.#droppedSampleCount;
  }
}
