import type {
  CommandEnvelope,
  CommandIdentity,
  CommandResult,
  DeliveryCommand,
  DeliveryId,
  RequestId,
  SessionId
} from "../../domain/src/index.js";
import { CommandEnvelopeSchema, DeliveryCommandSchema, DeliveryIdSchema, DeliveryStatusSchema, newRequestId } from "../../domain/src/index.js";
import type { EventDraft, SessionState } from "../../events/src/index.js";
import type { Renderer } from "./renderer.js";
import { z } from "zod";

interface StateTransition<TResult> {
  readonly drafts: readonly EventDraft[];
  readonly result: TResult;
}

type TransitionHandler<TResult> = (state: Readonly<SessionState>) => StateTransition<TResult>;

function createDeliveryEnvelope(sessionId: SessionId, producer: string): CommandEnvelope {
  const requestId: RequestId = newRequestId();
  return { requestId, sessionId, producer, causationId: requestId, correlationId: requestId };
}

export interface SessionTransitionSink {
  readonly sessionId: SessionId;
  readonly getState: () => Readonly<SessionState>;
  readonly execute: <TResult>(envelope: CommandEnvelope, commandIdentity: CommandIdentity, resultSchema: z.ZodType<TResult>, handler: TransitionHandler<TResult>) => Promise<CommandResult<TResult>>;
}

const AcknowledgedResultSchema = z.literal(true);
const CancelledResultSchema = z.object({ cancelled: z.literal(true) }).strict();
const RecoveredResultSchema = z.object({ recovered: z.literal(true) }).strict();
export const DeliveryReconnectResultSchema = z.object({
  deliveryId: DeliveryIdSchema,
  status: DeliveryStatusSchema,
  command: DeliveryCommandSchema.optional()
}).strict();
export type DeliveryReconnectResult = z.infer<typeof DeliveryReconnectResultSchema>;

export class DeliveryCoordinator {
  public constructor(private readonly writer: SessionTransitionSink) {}

  public async markStarted(deliveryId: DeliveryId): Promise<DeliveryCommand> {
    const envelope = createDeliveryEnvelope(this.writer.sessionId, "delivery-coordinator");
    const result = await this.writer.execute(envelope, { operation: "START_DELIVERY", payload: { deliveryId } }, DeliveryCommandSchema, (state): StateTransition<DeliveryCommand> => {
      const atom = state.deliveries[deliveryId];
      if (atom === undefined || atom.status !== "QUEUED") throw new Error("Only a queued delivery can start");
      return {
        drafts: [{ source: "APPLICATION", type: "DELIVERY_STARTED", payload: { deliveryId } }],
        result: { deliveryId, content: atom.content }
      };
    });
    return result.value;
  }

  public async reconnect(deliveryId: DeliveryId, envelope: CommandEnvelope): Promise<DeliveryReconnectResult> {
    const command = CommandEnvelopeSchema.parse(envelope);
    const result = await this.writer.execute(command, { operation: "RECONNECT_DELIVERY", payload: { deliveryId } }, DeliveryReconnectResultSchema, (state): StateTransition<DeliveryReconnectResult> => {
      const atom = state.deliveries[deliveryId];
      if (atom === undefined) throw new Error("Unknown delivery");
      const deliveryCommand: DeliveryCommand = { deliveryId, content: atom.content };
      if (atom.status === "QUEUED") {
        return {
          drafts: [{ source: "APPLICATION", type: "DELIVERY_STARTED", payload: { deliveryId } }],
          result: { deliveryId, status: "DELIVERING", command: deliveryCommand }
        };
      }
      if (atom.status === "DELIVERING") {
        return { drafts: [], result: { deliveryId, status: atom.status, command: deliveryCommand } };
      }
      return { drafts: [], result: { deliveryId, status: atom.status } };
    });
    return result.value;
  }

  public async acknowledgeExposed(deliveryId: DeliveryId, envelope?: CommandEnvelope): Promise<boolean> {
    const command = CommandEnvelopeSchema.parse(envelope ?? createDeliveryEnvelope(this.writer.sessionId, "renderer"));
    const result = await this.writer.execute(command, { operation: "ACK_DELIVERY_EXPOSED", payload: { deliveryId } }, AcknowledgedResultSchema, (state) => {
      const atom = state.deliveries[deliveryId];
      if (atom === undefined) throw new Error("Unknown delivery acknowledgement");
      if (atom.status === "EXPOSED" || atom.status === "COMPLETED") return { drafts: [], result: true };
      if (atom.status !== "DELIVERING") throw new Error(`Cannot expose delivery in ${atom.status}`);
      return { drafts: [{ source: "RENDERER", type: "DELIVERY_EXPOSED", payload: { deliveryId } }], result: true };
    });
    return result.value;
  }

  public async acknowledgeCompleted(deliveryId: DeliveryId, envelope?: CommandEnvelope): Promise<boolean> {
    const command = CommandEnvelopeSchema.parse(envelope ?? createDeliveryEnvelope(this.writer.sessionId, "renderer"));
    const result = await this.writer.execute(command, { operation: "ACK_DELIVERY_COMPLETED", payload: { deliveryId } }, AcknowledgedResultSchema, (state) => {
      const atom = state.deliveries[deliveryId];
      if (atom === undefined) throw new Error("Unknown delivery acknowledgement");
      if (atom.status === "COMPLETED") return { drafts: [], result: true };
      if (atom.status !== "EXPOSED") throw new Error(`Cannot complete delivery in ${atom.status}`);
      return { drafts: [{ source: "RENDERER", type: "DELIVERY_COMPLETED", payload: { deliveryId } }], result: true };
    });
    return result.value;
  }

  public async deliver(deliveryId: DeliveryId, renderer: Renderer): Promise<void> {
    const command = await this.markStarted(deliveryId);
    const acknowledgement = await renderer.deliver(command);
    if (acknowledgement.exposed) await this.acknowledgeExposed(deliveryId);
    if (acknowledgement.completed) await this.acknowledgeCompleted(deliveryId);
  }

  public async cancelBeforeExposure(deliveryId: DeliveryId, reason: string): Promise<void> {
    const envelope = createDeliveryEnvelope(this.writer.sessionId, "delivery-coordinator");
    await this.writer.execute(envelope, { operation: "CANCEL_DELIVERY", payload: { deliveryId, reason } }, CancelledResultSchema, (state): StateTransition<{ cancelled: true }> => {
      const atom = state.deliveries[deliveryId];
      if (atom === undefined) throw new Error("Unknown delivery");
      if (atom.status !== "QUEUED") throw new Error("Only a delivery known not to have started may be safely cancelled");
      return {
        drafts: [{ source: "APPLICATION", type: "DELIVERY_CANCELLED", payload: { deliveryId, reason } }],
        result: { cancelled: true }
      };
    });
  }

  public async recoverUncertainDeliveries(): Promise<readonly DeliveryId[]> {
    const inFlight = Object.values(this.writer.getState().deliveries)
      .filter((atom) => atom.status === "DELIVERING")
      .map((atom) => atom.deliveryId);
    for (const deliveryId of inFlight) {
      const envelope = createDeliveryEnvelope(this.writer.sessionId, "crash-recovery");
      await this.writer.execute(envelope, { operation: "RECOVER_DELIVERY", payload: { deliveryId } }, RecoveredResultSchema, (state): StateTransition<{ recovered: true }> => {
        const atom = state.deliveries[deliveryId];
        if (atom?.status !== "DELIVERING") {
          return { drafts: [], result: { recovered: true } };
        }
        return {
          drafts: [{ source: "RECOVERY", type: "DELIVERY_POSSIBLY_EXPOSED", payload: { deliveryId, reason: "Delivery began but persisted exposure acknowledgement is absent after restart" } }],
          result: { recovered: true }
        };
      });
    }
    return inFlight;
  }
}
