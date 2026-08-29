import type { DeliveryId, SessionId } from "../../../packages/domain/src/index.js";
import { DeliveryCoordinator } from "../../../packages/delivery/src/index.js";
import {
  type SessionRuntimeRegistry,
  type SessionWriter
} from "../../../packages/interview-engine/src/index.js";

/**
 * Process-lifetime recovery ownership shared by every transport adapter.
 * A session is recovered at most once successfully in one application runtime.
 */
export class SessionRecoveryCoordinator {
  private readonly recoveries = new Map<SessionId, Promise<readonly DeliveryId[]>>();

  public constructor(private readonly registry: SessionRuntimeRegistry) {}

  public getWriter(sessionId: SessionId): SessionWriter {
    return this.registry.get(sessionId);
  }

  public ensureRecovered(sessionId: SessionId): Promise<readonly DeliveryId[]> {
    const existing = this.recoveries.get(sessionId);
    if (existing !== undefined) return existing;

    const recovery = new DeliveryCoordinator(this.getWriter(sessionId))
      .recoverUncertainDeliveries();
    this.recoveries.set(sessionId, recovery);
    void recovery.catch(() => {
      if (this.recoveries.get(sessionId) === recovery) {
        this.recoveries.delete(sessionId);
      }
    });
    return recovery;
  }
}
