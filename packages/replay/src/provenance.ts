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
import {
  MAX_REPLAY_IDENTIFIER_CHARS,
  truncationInfo
} from "./bounds.js";
import type { ReplayEventProvenance } from "./types.js";

export type ReplayProjectionErrorCode =
  | "INVALID_INPUT"
  | "INVALID_EVENT_METADATA"
  | "INVALID_EVENT_SCHEMA"
  | "INVALID_EVENT_SEQUENCE"
  | "INVALID_EVENT_IDENTITY"
  | "MIXED_SESSION_IDS"
  | "INVALID_EVENT_SEMANTICS"
  | "EVALUATION_MISMATCH"
  | "INVALID_SESSION_SUMMARY"
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

const BoundedEventIdSchema = EventIdSchema.refine(
  (value) => value.length <= MAX_REPLAY_IDENTIFIER_CHARS
);
const BoundedSessionIdSchema = SessionIdSchema.refine(
  (value) => value.length <= MAX_REPLAY_IDENTIFIER_CHARS
);
const BoundedRequestIdSchema = RequestIdSchema.refine(
  (value) => value.length <= MAX_REPLAY_IDENTIFIER_CHARS
);

const SafeEventMetadataSchema = z.object({
  eventId: BoundedEventIdSchema,
  sessionId: BoundedSessionIdSchema,
  sequence: PositiveSafeIntegerSchema,
  schemaVersion: PositiveSafeIntegerSchema,
  source: z.string().min(1).max(64),
  wallTime: z.iso.datetime(),
  elapsedMs: NonnegativeSafeIntegerSchema,
  causationId: BoundedRequestIdSchema,
  correlationId: BoundedRequestIdSchema,
  type: z.string().min(1).max(160)
});

type SafeEventMetadata = z.infer<typeof SafeEventMetadataSchema>;

const KNOWN_EVENT_TYPE_MAP = {
  SESSION_STARTED: true,
  PROBLEM_PRESENTED: true,
  QUANT_RESEARCH_SCENARIO_INITIALIZED: true,
  QUANT_RESEARCH_ACTION_ACCEPTED: true,
  QUANT_RESEARCH_SCENARIO_COMPLETED: true,
  UTTERANCE_STARTED: true,
  UTTERANCE_DISCARDED: true,
  INPUT_EPISODE_STARTED: true,
  INPUT_EPISODE_UPDATED: true,
  INPUT_EPISODE_COMMITTED: true,
  TURN_COMMITTED: true,
  TRANSCRIPT_FINALIZED: true,
  TRANSCRIPT_CORRECTED: true,
  BOARD_PATCH_COMMITTED: true,
  VISION_REQUESTED: true,
  VISION_RESULT_ACCEPTED: true,
  VISION_RESULT_DISCARDED: true,
  LOCAL_COMPUTE_REQUESTED: true,
  LOCAL_COMPUTE_RESULT_ACCEPTED: true,
  LOCAL_COMPUTE_RESULT_DISCARDED: true,
  VERIFICATION_REQUESTED: true,
  VERIFICATION_RESULT_ACCEPTED: true,
  VERIFICATION_RESULT_DISCARDED: true,
  EVIDENCE_PROPOSED: true,
  STUDENT_EVIDENCE_UPDATED: true,
  STUDENT_EVIDENCE_INVALIDATED: true,
  PEDAGOGICAL_ACTION_SELECTED: true,
  MODEL_GENERATION_STARTED: true,
  GENERATION_CONTEXT_COMPILED: true,
  MODEL_PROPOSAL_RECEIVED: true,
  FORMAL_INTERPRETATION_PROPOSAL_RECEIVED: true,
  FORMAL_INTERPRETATION_PROPOSAL_REJECTED: true,
  MODEL_GENERATION_SUPERSEDED: true,
  PROPOSAL_VALIDATED: true,
  PROPOSAL_REJECTED: true,
  DELIVERY_QUEUED: true,
  DELIVERY_STARTED: true,
  DELIVERY_EXPOSED: true,
  DELIVERY_COMPLETED: true,
  DELIVERY_CANCELLED: true,
  DELIVERY_POSSIBLY_EXPOSED: true,
  POLICY_REVISION_CHANGED: true,
  PROBLEM_STATE_REVISION_CHANGED: true,
  SESSION_COMPLETED: true,
  SESSION_ARCHIVED: true,
  SESSION_RESUMED: true
} as const satisfies Readonly<Record<EventType, true>>;

const KNOWN_EVENT_TYPES = new Set<string>(Object.keys(KNOWN_EVENT_TYPE_MAP));

export interface NormalizedReplayEvent {
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
  readonly firstUnknownSequence?: number;
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

function stableKnownEventInput(
  raw: unknown,
  metadata: SafeEventMetadata
): Readonly<Record<string, unknown>> {
  try {
    const record = raw as Readonly<Record<string, unknown>>;
    const payload = record.payload;
    return { ...metadata, payload };
  } catch {
    throw new ReplayProjectionError("INVALID_EVENT_SCHEMA");
  }
}

export function normalizeReplayEvents(
  rawEvents: readonly unknown[],
  bounds: ReplayBounds,
  upcasters = new EventUpcasterRegistry()
): NormalizedReplayHistory {
  let inputIsArray: boolean;
  try {
    inputIsArray = Array.isArray(rawEvents);
  } catch {
    throw new ReplayProjectionError("INVALID_INPUT");
  }
  if (!inputIsArray) throw new ReplayProjectionError("INVALID_INPUT");

  let totalEventCount: number;
  try {
    totalEventCount = rawEvents.length;
  } catch {
    throw new ReplayProjectionError("INVALID_INPUT");
  }
  if (!Number.isSafeInteger(totalEventCount) || totalEventCount < 0) {
    throw new ReplayProjectionError("INVALID_INPUT");
  }

  const selectedCount = Math.min(totalEventCount, bounds.maxEvents);
  const selectedBySequence = new Map<number, {
    readonly raw: unknown;
    readonly metadata: SafeEventMetadata;
  }>();
  const selectedEventIds = new Set<string>();
  let sessionId: z.infer<typeof SessionIdSchema> | null = null;

  let iteratedEventCount = 0;
  try {
    for (const rawValue of rawEvents) {
      iteratedEventCount += 1;
      if (iteratedEventCount > totalEventCount) {
        throw new ReplayProjectionError("INVALID_INPUT");
      }
      const raw: unknown = rawValue;
      let parsed: ReturnType<typeof SafeEventMetadataSchema.safeParse>;
      try {
        parsed = SafeEventMetadataSchema.safeParse(raw);
      } catch {
        throw new ReplayProjectionError("INVALID_EVENT_METADATA");
      }
      if (!parsed.success) throw new ReplayProjectionError("INVALID_EVENT_METADATA");
      const metadata = parsed.data;
      sessionId ??= metadata.sessionId;
      if (metadata.sessionId !== sessionId) {
        throw new ReplayProjectionError("MIXED_SESSION_IDS");
      }

      if (metadata.sequence <= selectedCount) {
        if (selectedBySequence.has(metadata.sequence)) {
          throw new ReplayProjectionError("INVALID_EVENT_SEQUENCE");
        }
        if (selectedEventIds.has(metadata.eventId)) {
          throw new ReplayProjectionError("INVALID_EVENT_IDENTITY");
        }
        selectedEventIds.add(metadata.eventId);
        selectedBySequence.set(metadata.sequence, { raw, metadata });
      }
    }
  } catch (error) {
    if (error instanceof ReplayProjectionError) throw error;
    throw new ReplayProjectionError("INVALID_INPUT");
  }
  if (iteratedEventCount !== totalEventCount) {
    throw new ReplayProjectionError("INVALID_INPUT");
  }

  const selected: Array<{
    readonly raw: unknown;
    readonly metadata: SafeEventMetadata;
  }> = [];
  for (let sequence = 1; sequence <= selectedCount; sequence += 1) {
    const item = selectedBySequence.get(sequence);
    if (item === undefined) throw new ReplayProjectionError("INVALID_EVENT_SEQUENCE");
    selected.push(item);
  }

  const events: NormalizedReplayEvent[] = [];
  let hasUnknownEvents = false;
  let firstUnknownSequence: number | undefined;

  for (const item of selected) {
    const metadata = item.metadata;
    if (
      metadata.schemaVersion > CURRENT_EVENT_SCHEMA_VERSION
      || (
        metadata.schemaVersion === CURRENT_EVENT_SCHEMA_VERSION
        && !KNOWN_EVENT_TYPES.has(metadata.type)
      )
    ) {
      hasUnknownEvents = true;
      firstUnknownSequence ??= metadata.sequence;
      events.push({
        metadata,
        provenance: provenanceFor(metadata)
      });
      continue;
    }

    try {
      const event = upcasters.toCurrent(
        stableKnownEventInput(item.raw, metadata)
      );
      if (
        event.eventId !== metadata.eventId
        || event.sessionId !== metadata.sessionId
        || event.sequence !== metadata.sequence
        || event.source !== metadata.source
        || event.wallTime !== metadata.wallTime
        || event.elapsedMs !== metadata.elapsedMs
        || event.causationId !== metadata.causationId
        || event.correlationId !== metadata.correlationId
      ) {
        throw new ReplayProjectionError("INVALID_EVENT_SCHEMA");
      }
      events.push({
        metadata,
        event,
        provenance: provenanceFor(metadata, event)
      });
    } catch (error) {
      if (error instanceof ReplayProjectionError) throw error;
      if (
        metadata.schemaVersion < CURRENT_EVENT_SCHEMA_VERSION
        || KNOWN_EVENT_TYPES.has(metadata.type)
      ) {
        throw new ReplayProjectionError("INVALID_EVENT_SCHEMA");
      }
      hasUnknownEvents = true;
      firstUnknownSequence ??= metadata.sequence;
      events.push({
        metadata,
        provenance: provenanceFor(metadata)
      });
    }
  }

  return {
    sessionId,
    events,
    totalEventCount,
    eventTruncation: truncationInfo(totalEventCount, bounds.maxEvents),
    hasUnknownEvents,
    ...(firstUnknownSequence === undefined ? {} : { firstUnknownSequence })
  };
}
