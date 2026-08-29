import type { DeliveryCommand, DeliveryId } from "../../domain/src/index.js";

export interface RendererAcknowledgement {
  readonly deliveryId: DeliveryId;
  readonly exposed: boolean;
  readonly completed: boolean;
}

export interface Renderer {
  readonly deliver: (command: DeliveryCommand) => Promise<RendererAcknowledgement>;
}

export class MockRenderer implements Renderer {
  private readonly processed = new Map<DeliveryId, RendererAcknowledgement>();
  public readonly visibleDeliveryIds: DeliveryId[] = [];

  public async deliver(command: DeliveryCommand): Promise<RendererAcknowledgement> {
    const existing = this.processed.get(command.deliveryId);
    if (existing !== undefined) return existing;
    const acknowledgement = { deliveryId: command.deliveryId, exposed: true, completed: true } as const;
    this.processed.set(command.deliveryId, acknowledgement);
    this.visibleDeliveryIds.push(command.deliveryId);
    return acknowledgement;
  }
}

