import { z } from "zod";
import {
  AcknowledgeDeliveryCompletedCommandSchema,
  AcknowledgeDeliveryExposedCommandSchema,
  DeliveryCommandSchema,
  DeliveryIdSchema,
  RequestIdSchema,
  SessionIdSchema
} from "../../domain/src/index.js";

export const RENDERER_STREAM_PROTOCOL_VERSION = 1 as const;
export const MAX_RENDERER_STREAM_ATTACH_BYTES = 8 * 1024;
export const MAX_RENDERER_STREAM_MESSAGE_BYTES = 64 * 1024;

const UUID_SUFFIX_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SESSION_ID_PATTERN = new RegExp(`^session_${UUID_SUFFIX_PATTERN}$`, "i");
const DELIVERY_ID_PATTERN = new RegExp(`^delivery_${UUID_SUFFIX_PATTERN}$`, "i");
const REQUEST_ID_PATTERN = new RegExp(`^request_${UUID_SUFFIX_PATTERN}$`, "i");

export const RendererStreamSessionIdSchema = SessionIdSchema.refine(
  (value) => SESSION_ID_PATTERN.test(value),
  { message: "Malformed SessionId" }
);

export const RendererStreamDeliveryIdSchema = DeliveryIdSchema.refine(
  (value) => DELIVERY_ID_PATTERN.test(value),
  { message: "Malformed DeliveryId" }
);

export const RendererStreamRequestIdSchema = RequestIdSchema.refine(
  (value) => REQUEST_ID_PATTERN.test(value),
  { message: "Malformed RequestId" }
);

export const RendererStreamAttachRequestSchema = z.object({
  protocolVersion: z.literal(RENDERER_STREAM_PROTOCOL_VERSION),
  type: z.literal("ATTACH_RENDERER_STREAM"),
  sessionId: RendererStreamSessionIdSchema
}).strict();
export type RendererStreamAttachRequest = z.infer<typeof RendererStreamAttachRequestSchema>;

export const RendererStreamDeliveryCommandSchema = DeliveryCommandSchema.superRefine((command, context) => {
  if (!DELIVERY_ID_PATTERN.test(command.deliveryId)) {
    context.addIssue({
      code: "custom",
      path: ["deliveryId"],
      message: "Malformed DeliveryId"
    });
  }
});

export const RendererStreamMessageSchema = z.object({
  protocolVersion: z.literal(RENDERER_STREAM_PROTOCOL_VERSION),
  type: z.literal("DELIVERY_COMMAND"),
  command: RendererStreamDeliveryCommandSchema
}).strict();
export type RendererStreamMessage = z.infer<typeof RendererStreamMessageSchema>;

export const RendererAcknowledgementCommandSchema = z.discriminatedUnion("type", [
  AcknowledgeDeliveryExposedCommandSchema,
  AcknowledgeDeliveryCompletedCommandSchema
]).superRefine((command, context) => {
  if (!REQUEST_ID_PATTERN.test(command.requestId)) {
    context.addIssue({ code: "custom", path: ["requestId"], message: "Malformed RequestId" });
  }
  if (!SESSION_ID_PATTERN.test(command.sessionId)) {
    context.addIssue({ code: "custom", path: ["sessionId"], message: "Malformed SessionId" });
  }
  if (!DELIVERY_ID_PATTERN.test(command.deliveryId)) {
    context.addIssue({ code: "custom", path: ["deliveryId"], message: "Malformed DeliveryId" });
  }
});
export type RendererAcknowledgementCommand = z.infer<typeof RendererAcknowledgementCommandSchema>;

export const RendererStreamErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "ORIGIN_FORBIDDEN",
  "INVALID_CONTENT_TYPE",
  "INVALID_STREAM_REQUEST",
  "BODY_TOO_LARGE",
  "TOO_MANY_CONNECTIONS",
  "NOT_FOUND",
  "INTERNAL_ERROR"
]);

export const RendererStreamErrorResponseSchema = z.object({
  protocolVersion: z.literal(RENDERER_STREAM_PROTOCOL_VERSION),
  ok: z.literal(false),
  error: z.object({
    code: RendererStreamErrorCodeSchema,
    message: z.string().min(1).max(200)
  }).strict()
}).strict();
export type RendererStreamErrorResponse = z.infer<typeof RendererStreamErrorResponseSchema>;
