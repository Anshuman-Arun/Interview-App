import { SessionEventSchema, type SessionEvent } from "./schemas.js";

export interface EventUpcaster {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly upcast: (event: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
}

export class EventUpcasterRegistry {
  private readonly byVersion = new Map<number, EventUpcaster>();

  public constructor(upcasters: readonly EventUpcaster[] = []) {
    for (const upcaster of upcasters) this.byVersion.set(upcaster.fromVersion, upcaster);
  }

  public toCurrent(raw: unknown): SessionEvent {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Persisted event must be an object");
    let current = raw as Readonly<Record<string, unknown>>;
    const rawVersion = current.schemaVersion;
    if (typeof rawVersion !== "number") throw new Error("Persisted event has no numeric schemaVersion");
    let version: number = rawVersion;
    while (version < 1) {
      const upcaster = this.byVersion.get(version);
      if (upcaster === undefined) throw new Error(`No event upcaster registered from schema version ${String(version)}`);
      current = upcaster.upcast(current);
      version = upcaster.toVersion;
    }
    return SessionEventSchema.parse(current);
  }
}
