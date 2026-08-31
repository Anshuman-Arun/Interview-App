export const LOCAL_COMPONENT_STATES = [
  "STOPPED",
  "STARTING",
  "READY",
  "DEGRADED",
  "STOPPING",
  "FAILED"
] as const;

export type LocalComponentState = (typeof LOCAL_COMPONENT_STATES)[number];

export interface LocalComponentHandshake {
  readonly componentVersion?: string;
  readonly protocolVersion?: string | number;
  readonly modelVersionOrHash?: string;
  readonly capabilities?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LocalExpectedHandshake {
  readonly componentVersion?: string;
  readonly protocolVersion?: string | number;
}

export type LocalReadinessDecision =
  | boolean
  | {
      readonly ready: boolean;
      readonly detail?: string;
      readonly handshake?: LocalComponentHandshake;
    };

export interface LocalReadinessContext {
  readonly componentId: string;
  readonly pid: number;
  readonly signal: AbortSignal;
}

export type LocalReadinessStrategy =
  | {
      readonly kind: "STABLE_PROCESS";
      readonly stableMs: number;
    }
  | {
      readonly kind: "STDOUT_LINE";
      readonly evaluate: (line: string) => LocalReadinessDecision;
    }
  | {
      readonly kind: "STDOUT_JSON";
      readonly evaluate: (message: unknown) => LocalReadinessDecision;
    }
  | {
      readonly kind: "HTTP_LOOPBACK";
      readonly url: string;
      readonly intervalMs?: number;
      readonly evaluate?: (response: Response) => LocalReadinessDecision | Promise<LocalReadinessDecision>;
    }
  | {
      readonly kind: "CUSTOM_LOCAL";
      readonly intervalMs?: number;
      readonly probe: (context: LocalReadinessContext) => LocalReadinessDecision | Promise<LocalReadinessDecision>;
    };

export type LocalRestartPolicy =
  | { readonly mode: "NEVER" }
  | {
      readonly mode: "ON_FAILURE";
      readonly maxRetries: number;
      readonly backoffMs?: number;
      readonly maxBackoffMs?: number;
    };

export interface LocalEnvironmentDefinition {
  readonly inherit?: readonly string[];
  readonly values?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface LocalOutputLimits {
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly maxLineBytes?: number;
}

export interface LocalShutdownControl {
  readonly componentId: string;
  readonly pid: number;
  writeStdin(data: string): Promise<void>;
  endStdin(): void;
}

export interface LocalComponentDefinition {
  readonly id: string;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: LocalEnvironmentDefinition;
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly terminationTimeoutMs?: number;
  readonly readiness: LocalReadinessStrategy;
  readonly restartPolicy?: LocalRestartPolicy;
  readonly expectedHandshake?: LocalExpectedHandshake;
  readonly output?: LocalOutputLimits;
  readonly gracefulShutdown?: (control: LocalShutdownControl) => void | Promise<void>;
}

export interface LocalOutputSnapshot {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

export interface LocalExitRecord {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timestamp: string;
  readonly previousState: LocalComponentState;
  readonly unexpected: boolean;
  readonly stderrTail: readonly string[];
}

export interface LocalFailureSnapshot {
  readonly code: string;
  readonly message: string;
  readonly timestamp: string;
}

export interface LocalReadinessSnapshot {
  readonly kind: LocalReadinessStrategy["kind"];
  readonly ready: boolean;
  readonly detail?: string;
}

export interface LocalComponentStatus {
  readonly componentId: string;
  readonly state: LocalComponentState;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly readyAt?: string;
  readonly readiness: LocalReadinessSnapshot;
  readonly lastExit?: LocalExitRecord;
  readonly restartCount: number;
  readonly handshake?: LocalComponentHandshake;
  readonly failure?: LocalFailureSnapshot;
  readonly stdout: LocalOutputSnapshot;
  readonly stderr: LocalOutputSnapshot;
}

export type LocalStopDisposition = "ALREADY_STOPPED" | "GRACEFUL" | "TERMINATED" | "FORCED";

export interface LocalStopResult {
  readonly componentId: string;
  readonly disposition: LocalStopDisposition;
}

export interface LocalRuntimeManagerOptions {
  readonly parentEnvironment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly fetch?: typeof globalThis.fetch;
}
