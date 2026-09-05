export const LOCAL_MODEL_ACTIVATION_ARG = "--activate-local-models";

const ACTIVATION_RETRY_REASON_CODES = new Set([
  "START_CANCELLED",
  "WORKER_START_FAILED",
  "WORKER_FAILED",
  "WORKER_STOPPED",
  "WORKER_RESTARTING",
  "VOICE_RUNTIME_INCOMPLETE"
]);

export function isLocalModelActivationLaunch(argv: readonly string[]): boolean {
  return argv.includes(LOCAL_MODEL_ACTIVATION_ARG);
}

export function shouldUsePreparedRuntimeStartupBudget(input: {
  readonly activationRequested: boolean;
  readonly hasPreparedRuntimeViews: boolean;
}): boolean {
  return input.activationRequested && input.hasPreparedRuntimeViews;
}

export function relaunchArgsForLocalModelActivation(
  argv: readonly string[],
  activationRequested: boolean
): string[] {
  const args = argv
    .slice(1)
    .filter((arg) => arg !== LOCAL_MODEL_ACTIVATION_ARG);
  return activationRequested
    ? [...args, LOCAL_MODEL_ACTIVATION_ARG]
    : args;
}

export function runtimeCapabilityNeedsActivationRetry(
  status: {
    readonly state: string;
    readonly reasonCode?: string;
  } | undefined
): boolean {
  return status !== undefined
    && status.state !== "READY"
    && status.reasonCode !== undefined
    && ACTIVATION_RETRY_REASON_CODES.has(status.reasonCode);
}
