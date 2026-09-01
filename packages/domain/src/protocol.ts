import { z } from "zod";
import { DeliveryCommandSchema, DeliveryStatusSchema } from "./delivery.js";
import { InterviewCatalogEntrySchema, InterviewProblemPublicViewSchema, InterviewSessionConfigurationSchema } from "./session-configuration.js";
import {
  DeliveryIdSchema,
  InputEpisodeIdSchema,
  RequestIdSchema,
  SessionIdSchema,
  TurnIdSchema
} from "./ids.js";

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
  /**
   * New callers should provide configuration. problemId is a legacy Ramsey-only
   * compatibility field and may not be combined with configuration.
   */
  configuration: InterviewSessionConfigurationSchema.optional(),
  problemId: z.string().min(1).max(128).optional()
}).strict();

export const ListInterviewCatalogCommandSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  requestId: RequestIdSchema,
  type: z.literal("LIST_INTERVIEW_CATALOG")
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

export const GetSessionSummaryCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("GET_SESSION_SUMMARY")
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
  ListInterviewCatalogCommandSchema,
  ListSessionsCommandSchema,
  ResumeSessionCommandSchema,
  CompleteSessionCommandSchema,
  ArchiveSessionCommandSchema,
  CommitTypedInputCommandSchema,
  GetSessionSummaryCommandSchema,
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
  sessionId: SessionIdSchema,
  configuration: InterviewSessionConfigurationSchema.optional(),
  problem: InterviewProblemPublicViewSchema.optional()
}).strict();

export const InterviewCatalogResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("INTERVIEW_CATALOG"),
  entries: z.array(InterviewCatalogEntrySchema).max(256)
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
  configuration: InterviewSessionConfigurationSchema.optional(),
  problem: InterviewProblemPublicViewSchema.optional(),
  problemId: z.string().min(1).optional(),
  problemVersion: z.string().min(1).optional(),
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

export const SessionSummaryResponseSchema = ResponseBaseSchema.extend({
  ok: z.literal(true),
  type: z.literal("SESSION_SUMMARY"),
  sessionId: SessionIdSchema,
  sequence: NonnegativeSafeIntegerSchema,
  started: z.boolean(),
  status: SessionStatusSchema.optional(),
  configuration: InterviewSessionConfigurationSchema.optional(),
  problem: InterviewProblemPublicViewSchema.optional(),
  problemId: z.string().min(1).optional(),
  problemVersion: z.string().min(1).optional(),
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
  InterviewCatalogResponseSchema,
  SessionsListResponseSchema,
  SessionResumedResponseSchema,
  SessionCompletedResponseSchema,
  SessionArchivedResponseSchema,
  InputCommittedResponseSchema,
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
