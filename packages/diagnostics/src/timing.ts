import { z } from "zod";
import { sanitizeDiagnosticRecord } from "./sanitize.js";
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
  operation: z.string().min(1),
  category: TimingOperationCategorySchema,
  elapsedMs: z.number().nonnegative(),
  outcome: TimingOutcomeSchema,
  tags: DiagnosticRecordSchema.optional()
}).strict();
export type OperationTiming = z.infer<typeof OperationTimingSchema>;

export const TimingAggregateSchema = z.object({
  operation: z.string().min(1),
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
}

function cloneTiming(sample: OperationTiming): OperationTiming {
  return Object.freeze({
    operation: sample.operation,
    category: sample.category,
    elapsedMs: sample.elapsedMs,
    outcome: sample.outcome,
    ...(sample.tags === undefined ? {} : { tags: Object.freeze({ ...sample.tags }) })
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? 0;
}

export function aggregateTimings(samples: readonly OperationTiming[]): readonly TimingAggregate[] {
  const groups = new Map<string, OperationTiming[]>();
  for (const rawSample of samples) {
    const sample = OperationTimingSchema.parse(rawSample);
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
      .sort((left, right) => left.category.localeCompare(right.category)
        || left.operation.localeCompare(right.operation))
  );
}

export class TimingRecorder {
  readonly #now: () => number;
  readonly #samples: OperationTiming[] = [];

  public constructor(options: TimingRecorderOptions = {}) {
    this.#now = options.now ?? (() => globalThis.performance.now());
  }

  public start(
    operation: string,
    category: TimingOperationCategory,
    tags?: Readonly<Record<string, unknown>>
  ): TimingSpan {
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
          operation,
          category,
          elapsedMs,
          outcome,
          ...(mergedTags === undefined ? {} : { tags: mergedTags })
        });
        const sample = cloneTiming(parsed);
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
}
