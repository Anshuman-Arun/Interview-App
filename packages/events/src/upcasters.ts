import { CURRENT_EVENT_SCHEMA_VERSION, SessionEventSchema, type SessionEvent } from "./schemas.js";

export interface EventUpcaster {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly upcast: (event: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
}

const builtInUpcasters: readonly EventUpcaster[] = [{
  fromVersion: 1,
  toVersion: 2,
  upcast: (event) => ({ ...event, schemaVersion: 2 })
}, {
  fromVersion: 2,
  toVersion: 3,
  upcast: (event) => ({ ...event, schemaVersion: 3 })
}];

export class EventUpcasterRegistry {
  private readonly byVersion = new Map<number, EventUpcaster>();

  public constructor(upcasters: readonly EventUpcaster[] = []) {
    for (const upcaster of [...builtInUpcasters, ...upcasters]) {
      if (!Number.isInteger(upcaster.fromVersion) || !Number.isInteger(upcaster.toVersion) || upcaster.toVersion <= upcaster.fromVersion) {
        throw new Error("Event upcasters must advance between positive integer schema versions");
      }
      if (this.byVersion.has(upcaster.fromVersion)) {
        throw new Error(`Multiple event upcasters registered from schema version ${String(upcaster.fromVersion)}`);
      }
      this.byVersion.set(upcaster.fromVersion, upcaster);
    }
  }

  public toCurrent(raw: unknown): SessionEvent {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Persisted event must be an object");
    let current = raw as Readonly<Record<string, unknown>>;
    const rawVersion = current.schemaVersion;
    if (typeof rawVersion !== "number") throw new Error("Persisted event has no numeric schemaVersion");
    let version: number = rawVersion;
    while (version < CURRENT_EVENT_SCHEMA_VERSION) {
      const upcaster = this.byVersion.get(version);
      if (upcaster === undefined) throw new Error(`No event upcaster registered from schema version ${String(version)}`);
      current = upcaster.upcast(current);
      version = upcaster.toVersion;
      if (current.schemaVersion !== version) {
        throw new Error("Event upcaster output schemaVersion does not match its declared target");
      }
    }
    return SessionEventSchema.parse(current);
  }
}
