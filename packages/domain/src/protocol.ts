import { z } from "zod";
import { DeliveryCommandSchema, DeliveryStatusSchema } from "./delivery.js";
import {
  InterviewCatalogEntrySchema,
  InterviewProblemPublicViewSchema,
  InterviewSessionConfigurationSchema,
  ProviderLaunchOptionSchema,
  SessionConfigurationSourceSchema
} from "./session-configuration.js";
import {
  DeliveryIdSchema,
  InputEpisodeIdSchema,
  RequestIdSchema,
  SessionIdSchema,
  TurnIdSchema
} from "./ids.js";
import { BoardRevisionSchema } from "./revisions.js";
import {
  QuantResearchCandidateActionSchema,
  QuantResearchPublicStateSchema,
  QuantTradingCandidateActionSchema,
  QuantTradingPublicStateSchema
} from "./quant-runtime.js";
import {
  BoardShapeIdSchema,
  MAX_AUTHORITATIVE_BOARD_SHAPES,
  NormalizedBoardMutationSchema
} from "./whiteboard.js";

export const ProtocolVersionSchema = z.literal(1);

export const LocalClientIdentitySchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  clientToken: z.string().min(32),
  origin: z.url()
}).strict();

export const SessionStatusSchema = z.enum(["CREATED", "ACTIVE", "COMPLETED", "ARCHIVED"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

const NonnegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Expected a non-negative safe integer" }
);

export const StoredSessionSummarySchema = z.object({
  sessionId: SessionIdSchema,
  problemId: z.string().min(1).optional(),
  problemVersion: z.string().min(1).optional(),
  status: SessionStatusSchema,
  sequence: NonnegativeSafeIntegerSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  eventCount: NonnegativeSafeIntegerSchema
}).strict();
export type StoredSessionSummary = z.infer<typeof StoredSessionSummarySchema>;

export const SessionHistoryEntrySchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("STUDENT"),
    sequence: z.number().int().positive(),
    occurredAt: z.iso.datetime(),
    turnId: TurnIdSchema,
    inputEpisodeId: InputEpisodeIdSchema,
    text: z.string().min(1)
  }).strict(),
  z.object({
    role: z.literal("INTERVIEWER"),
    sequence: z.number().int().positive(),
    occurredAt: z.iso.datetime(),
    deliveryId: DeliveryIdSchema,
    text: z.string().min(1),
    status: DeliveryStatusSchema
  }).strict()
]);
export type SessionHistoryEntry = z.infer<typeof SessionHistoryEntrySchema>;

const ProtocolCommandBaseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema
});

export const StartSessionCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("START_SESSION"),
  problemId: z.string().min(1).optional()
}).strict();

export const StartConfiguredSessionCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("START_CONFIGURED_SESSION"),
  configuration: InterviewSessionConfigurationSchema
}).strict();

export const ListInterviewCatalogCommandSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  requestId: RequestIdSchema,
  type: z.literal("LIST_INTERVIEW_CATALOG")
}).strict();

export const ListProviderOptionsCommandSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  requestId: RequestIdSchema,
  type: z.literal("LIST_PROVIDER_OPTIONS")
}).strict();

export const ListSessionsCommandSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  requestId: RequestIdSchema,
  type: z.literal("LIST_SESSIONS")
}).strict();

export const ResumeSessionCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("RESUME_SESSION")
}).strict();

export const CompleteSessionCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("COMPLETE_SESSION"),
  summary: z.string().min(1).optional()
}).strict();

export const ArchiveSessionCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("ARCHIVE_SESSION"),
  reason: z.string().min(1).optional()
}).strict();

export const CommitTypedInputCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("COMMIT_TYPED_INPUT"),
  text: z.string().trim().min(1).max(20_000)
}).strict();

export const CommitBoardMutationCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("COMMIT_BOARD_MUTATION"),
  mutation: NormalizedBoardMutationSchema
}).strict();

export const GetBoardStateCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("GET_BOARD_STATE")
}).strict();

export const GetSessionSummaryCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("GET_SESSION_SUMMARY")
}).strict();

export const GetInterviewSessionContextCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("GET_INTERVIEW_SESSION_CONTEXT")
}).strict();

export const GetQuantSessionStateCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("GET_QUANT_SESSION_STATE")
}).strict();

export const SubmitQuantTradingActionCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("SUBMIT_QUANT_TRADING_ACTION"),
  expectedRound: z.number().int().min(1).max(256),
  action: QuantTradingCandidateActionSchema
}).strict();

export const SubmitQuantResearchActionCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("SUBMIT_QUANT_RESEARCH_ACTION"),
  expectedActionCount: z.number().int().min(0).max(64),
  action: QuantResearchCandidateActionSchema
}).strict();

export const ReconnectDeliveryCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("RECONNECT_DELIVERY"),
  deliveryId: DeliveryIdSchema
}).strict();

export const AcknowledgeDeliveryExposedCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("ACK_DELIVERY_EXPOSED"),
  deliveryId: DeliveryIdSchema
}).strict();

export const AcknowledgeDeliveryCompletedCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("ACK_DELIVERY_COMPLETED"),
  deliveryId: DeliveryIdSchema
}).strict();

export const ClientCommandSchema = z.discriminatedUnion("type", [
  StartSessionCommandSchema,
  StartConfiguredSessionCommandSchema,
  ListInterviewCatalogCommandSchema,
  ListProviderOptionsCommandSchema,
  ListSessionsCommandSchema,
  ResumeSessionCommandSchema,
  CompleteSessionCommandSchema,
  ArchiveSessionCommandSchema,
  CommitTypedInputCommandSchema,
  CommitBoardMutationCommandSchema,
  GetBoardStateCommandSchema,
  GetSessionSummaryCommandSchema,
  GetInterviewSessionContextCommandSchema,
  GetQuantSessionStateCommandSchema,
  SubmitQuantTradingActionCommandSchema,
  SubmitQuantResearchActionCommandSchema,
  ReconnectDeliveryCommandSchema,
  AcknowledgeDeliveryExposedCommandSchema,
  AcknowledgeDeliveryCompletedCommandSchema
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

const ResponseBaseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  requestId: RequestIdSchema
});

export const SessionStartedResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("SESSION_STARTED"),
  sessionId: SessionIdSchema
}).strict();

export const ConfiguredSessionStartedResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("CONFIGURED_SESSION_STARTED"),
  sessionId: SessionIdSchema,
  configuration: InterviewSessionConfigurationSchema,
  problem: InterviewProblemPublicViewSchema.optional()
}).strict();

export const InterviewSessionContextResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("INTERVIEW_SESSION_CONTEXT"),
  sessionId: SessionIdSchema,
  configuration: InterviewSessionConfigurationSchema,
  configurationSource: SessionConfigurationSourceSchema,
  problem: InterviewProblemPublicViewSchema.optional()
}).strict();

export const InterviewCatalogResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("INTERVIEW_CATALOG"),
  entries: z.array(InterviewCatalogEntrySchema).max(256)
}).strict();

export const ProviderOptionsResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("PROVIDER_OPTIONS"),
  options: z.array(ProviderLaunchOptionSchema).max(256)
}).strict();

export const QuantTradingStateResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("QUANT_TRADING_STATE"),
  sessionId: SessionIdSchema,
  state: QuantTradingPublicStateSchema
}).strict();

export const QuantResearchStateResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("QUANT_RESEARCH_STATE"),
  sessionId: SessionIdSchema,
  state: QuantResearchPublicStateSchema
}).strict();

export const SessionsListResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("SESSIONS_LIST"),
  sessions: z.array(StoredSessionSummarySchema)
}).strict();

export const SessionResumedResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("SESSION_RESUMED"),
  sessionId: SessionIdSchema,
  sequence: NonnegativeSafeIntegerSchema,
  started: z.boolean(),
  status: SessionStatusSchema,
  problemId: z.string().min(1).optional(),
  contextEpoch: z.number().int().nonnegative(),
  deliveryStatuses: z.record(DeliveryIdSchema, DeliveryStatusSchema),
  history: z.array(SessionHistoryEntrySchema).default([])
}).strict();

export const SessionCompletedResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("SESSION_COMPLETED"),
  sessionId: SessionIdSchema,
  completedAt: z.string().min(1)
}).strict();

export const SessionArchivedResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("SESSION_ARCHIVED"),
  sessionId: SessionIdSchema,
  archivedAt: z.string().min(1)
}).strict();

export const InputCommittedResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("INPUT_COMMITTED"),
  inputEpisodeId: InputEpisodeIdSchema,
  turnId: TurnIdSchema
}).strict();

export const BoardMutationCommittedResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("BOARD_MUTATION_COMMITTED"),
  sessionId: SessionIdSchema,
  committed: z.boolean(),
  boardRevision: BoardRevisionSchema,
  reason: z.enum(["STALE_CLIENT", "MUTATION_CONFLICT", "BOARD_AUTHORITY_UNKNOWN"]).optional()
}).strict().superRefine((response, context) => {
  if (response.committed === (response.reason !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "Rejected board mutations require a reason and committed mutations must not have one"
    });
  }
});

export const BoardStateResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("BOARD_STATE"),
  sessionId: SessionIdSchema,
  boardRevision: BoardRevisionSchema,
  shapeAuthorityKnown: z.boolean(),
  shapeRevisions: z.array(z.object({
    shapeId: BoardShapeIdSchema,
    revision: z.number().refine(
      (value) => Number.isSafeInteger(value) && value >= 1,
      { message: "Shape revision must be a positive safe integer" }
    ),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/u)
  }).strict()).max(MAX_AUTHORITATIVE_BOARD_SHAPES)
}).strict().superRefine((response, context) => {
  const ids = response.shapeRevisions.map((entry) => entry.shapeId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      path: ["shapeRevisions"],
      message: "Board state shape revisions must contain unique shape IDs"
    });
  }
});

export const SessionSummaryResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("SESSION_SUMMARY"),
  sessionId: SessionIdSchema,
  sequence: NonnegativeSafeIntegerSchema,
  started: z.boolean(),
  status: SessionStatusSchema.optional(),
  contextEpoch: z.number().int().nonnegative(),
  deliveryStatuses: z.record(DeliveryIdSchema, DeliveryStatusSchema),
  history: z.array(SessionHistoryEntrySchema).default([])
}).strict();

export const DeliveryReconnectResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("DELIVERY_RECONNECT"),
  deliveryId: DeliveryIdSchema,
  status: DeliveryStatusSchema,
  command: DeliveryCommandSchema.optional()
}).strict();

export const DeliveryAcknowledgedResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("DELIVERY_ACKNOWLEDGED"),
  deliveryId: DeliveryIdSchema,
  acknowledgement: z.enum(["EXPOSED", "COMPLETED"])
}).strict();

export const ProtocolSuccessResponseSchema = z.discriminatedUnion("type", [
  SessionStartedResponseSchema,
  ConfiguredSessionStartedResponseSchema,
  InterviewSessionContextResponseSchema,
  InterviewCatalogResponseSchema,
  ProviderOptionsResponseSchema,
  QuantTradingStateResponseSchema,
  QuantResearchStateResponseSchema,
  SessionsListResponseSchema,
  SessionResumedResponseSchema,
  SessionCompletedResponseSchema,
  SessionArchivedResponseSchema,
  InputCommittedResponseSchema,
  BoardMutationCommittedResponseSchema,
  BoardStateResponseSchema,
  SessionSummaryResponseSchema,
  DeliveryReconnectResponseSchema,
  DeliveryAcknowledgedResponseSchema
]);
export type ProtocolSuccessResponse = z.infer<typeof ProtocolSuccessResponseSchema>;

export const ProtocolErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "ORIGIN_FORBIDDEN",
  "INVALID_CONTENT_TYPE",
  "INVALID_COMMAND",
  "BODY_TOO_LARGE",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR"
]);

export const ProtocolErrorResponseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  ok: z.literal(false),
  error: z.object({
    code: ProtocolErrorCodeSchema,
    message: z.string().min(1).max(200)
  }).strict()
}).strict();
export type ProtocolErrorResponse = z.infer<typeof ProtocolErrorResponseSchema>;
