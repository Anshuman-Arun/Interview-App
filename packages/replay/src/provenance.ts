import { z } from "zod";
import {
  EventIdSchema,
  RequestIdSchema,
  SessionIdSchema
} from "../../domain/src/index.js";
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  EventUpcasterRegistry,
  type EventType,
  type SessionEvent
} from "../../events/src/index.js";
import type { ReplayBounds, TruncationInfo } from "./bounds.js";
import { truncationInfo } from "./bounds.js";
import type { ReplayEventProvenance } from "./types.js";

export type ReplayProjectionErrorCode =
  | "INVALID_INPUT"
  | "INVALID_EVENT_METADATA"
  | "INVALID_EVENT_SCHEMA"
  | "INVALID_EVENT_SEQUENCE"
  | "MIXED_SESSION_IDS"
  | "INVALID_EVENT_SEMANTICS"
  | "EVALUATION_MISMATCH"
  | "DUPLICATE_SESSION";

export class ReplayProjectionError extends Error {
  public constructor(public readonly code: ReplayProjectionErrorCode) {
    super("Replay projection rejected invalid or incompatible authoritative history");
    this.name = "ReplayProjectionError";
  }
}

const PositiveSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  { message: "Expected a positive safe integer" }
);
const NonnegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Expected a non-negative safe integer" }
);

const SafeEventMetadataSchema = z.object({
  eventId: EventIdSchema,
  sessionId: SessionIdSchema,
  sequence: PositiveSafeIntegerSchema,
  schemaVersion: PositiveSafeIntegerSchema,
  source: z.string().min(1).max(64),
  wallTime: z.iso.datetime(),
  elapsedMs: NonnegativeSafeIntegerSchema,
  causationId: RequestIdSchema,
  correlationId: RequestIdSchema,
  type: z.string().min(1).max(160)
}).passthrough();

type SafeEventMetadata = z.infer<typeof SafeEventMetadataSchema>;

const KNOWN_EVENT_TYPES = new Set<string>([
  "SESSION_STARTED",
  "PROBLEM_PRESENTED",
  "UTTERANCE_STARTED",
  "UTTERANCE_DISCARDED",
  "INPUT_EPISODE_STARTED",
  "INPUT_EPISODE_UPDATED",
  "INPUT_EPISODE_COMMITTED",
  "TURN_COMMITTED",
  "TRANSCRIPT_FINALIZED",
  "TRANSCRIPT_CORRECTED",
  "BOARD_PATCH_COMMITTED",
  "VISION_REQUESTED",
  "VISION_RESULT_ACCEPTED",
  "VISION_RESULT_DISCARDED",
  "LOCAL_COMPUTE_REQUESTED",
  "LOCAL_COMPUTE_RESULT_ACCEPTED",
  "LOCAL_COMPUTE_RESULT_DISCARDED",
  "VERIFICATION_REQUESTED",
  "VERIFICATION_RESULT_ACCEPTED",
  "VERIFICATION_RESULT_DISCARDED",
  "EVIDENCE_PROPOSED",
  "STUDENT_EVIDENCE_UPDATED",
  "STUDENT_EVIDENCE_INVALIDATED",
  "PEDAGOGICAL_ACTION_SELECTED",
  "MODEL_GENERATION_STARTED",
  "GENERATION_CONTEXT_COMPILED",
  "MODEL_PROPOSAL_RECEIVED",
  "FORMAL_INTERPRETATION_PROPOSAL_RECEIVED",
  "FORMAL_INTERPRETATION_PROPOSAL_REJECTED",
  "MODEL_GENERATION_SUPERSEDED",
  "PROPOSAL_VALIDATED",
  "PROPOSAL_REJECTED",
  "DELIVERY_QUEUED",
  "DELIVERY_STARTED",
  "DELIVERY_EXPOSED",
  "DELIVERY_COMPLETED",
  "DELIVERY_CANCELLED",
  "DELIVERY_POSSIBLY_EXPOSED",
  "POLICY_REVISION_CHANGED",
  "PROBLEM_STATE_REVISION_CHANGED",
  "SESSION_COMPLETED",
  "SESSION_ARCHIVED",
  "SESSION_RESUMED"
] satisfies readonly EventType[]);

export interface NormalizedReplayEvent {
  readonly raw: unknown;
  readonly metadata: SafeEventMetadata;
  readonly provenance: ReplayEventProvenance;
  readonly event?: SessionEvent;
}

export interface NormalizedReplayHistory {
  readonly sessionId: z.infer<typeof SessionIdSchema> | null;
  readonly events: readonly NormalizedReplayEvent[];
  readonly totalEventCount: number;
  readonly eventTruncation: TruncationInfo;
  readonly hasUnknownEvents: boolean;
}

function provenanceFor(metadata: SafeEventMetadata, event?: SessionEvent): ReplayEventProvenance {
  return {
    eventId: metadata.eventId,
    sessionId: metadata.sessionId,
    sequence: metadata.sequence,
    persistedSchemaVersion: metadata.schemaVersion,
    ...(event === undefined ? {} : { logicalSchemaVersion: event.schemaVersion }),
    persistedType: metadata.type,
    ...(event === undefined ? {} : { logicalType: event.type }),
    source: metadata.source,
    wallTime: metadata.wallTime,
    elapsedMs: metadata.elapsedMs,
    causationId: metadata.causationId,
    correlationId: metadata.correlationId
  };
}

export function normalizeReplayEvents(
  rawEvents: readonly unknown[],
  bounds: ReplayBounds,
  upcasters = new EventUpcasterRegistry()
): NormalizedReplayHistory {
  if (!Array.isArray(rawEvents)) throw new ReplayProjectionError("INVALID_INPUT");

  const withMetadata = rawEvents.map((raw) => {
    const parsed = SafeEventMetadataSchema.safeParse(raw);
    if (!parsed.success) throw new ReplayProjectionError("INVALID_EVENT_METADATA");
    return { raw, metadata: parsed.data };
  });

  withMetadata.sort((left, right) => left.metadata.sequence - right.metadata.sequence);

  let sessionId: z.infer<typeof SessionIdSchema> | null = null;
  let expectedSequence = 1;
  for (const item of withMetadata) {
    sessionId ??= item.metadata.sessionId;
    if (item.metadata.sessionId !== sessionId) throw new ReplayProjectionError("MIXED_SESSION_IDS");
    if (item.metadata.sequence !== expectedSequence) throw new ReplayProjectionError("INVALID_EVENT_SEQUENCE");
    expectedSequence += 1;
  }

  const selected = withMetadata.slice(0, bounds.maxEvents);
  const events: NormalizedReplayEvent[] = [];
  let hasUnknownEvents = false;

  for (const item of selected) {
    const metadata = item.metadata;
    if (metadata.schemaVersion > CURRENT_EVENT_SCHEMA_VERSION) {
      hasUnknownEvents = true;
      events.push({
        raw: item.raw,
        metadata,
        provenance: provenanceFor(metadata)
      });
      continue;
    }

    try {
      const event = upcasters.toCurrent(item.raw);
      events.push({
        raw: item.raw,
        metadata,
        event,
        provenance: provenanceFor(metadata, event)
      });
    } catch {
      if (
        metadata.schemaVersion < CURRENT_EVENT_SCHEMA_VERSION
        || KNOWN_EVENT_TYPES.has(metadata.type)
      ) {
        throw new ReplayProjectionError("INVALID_EVENT_SCHEMA");
      }
      hasUnknownEvents = true;
      events.push({
        raw: item.raw,
        metadata,
        provenance: provenanceFor(metadata)
      });
    }
  }

  return {
    sessionId,
    events,
    totalEventCount: rawEvents.length,
    eventTruncation: truncationInfo(rawEvents.length, bounds.maxEvents),
    hasUnknownEvents
  };
}
