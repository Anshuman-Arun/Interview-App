import { z } from "zod";
import { DeliveryCommandSchema, DeliveryStatusSchema } from "./delivery.js";
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

const ProtocolCommandBaseSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema
});

export const StartSessionCommandSchema = ProtocolCommandBaseSchema.extend({
  type: z.literal("START_SESSION")
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
  sessionId: SessionIdSchema
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
  sequence: z.number().int().nonnegative(),
  started: z.boolean(),
  contextEpoch: z.number().int().nonnegative(),
  deliveryStatuses: z.record(DeliveryIdSchema, DeliveryStatusSchema)
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
