import fc from "fast-check";

export const DEFAULT_ADVERSARIAL_SEED = 20260829;
const VALIDATION_STRESS_RUNS = 100;
const VALIDATION_STRESS_BASE_SEED = 314159;

export type CoreScheduleOperation =
  | "RELEASE_PROVIDER_PRIMARY"
  | "RELEASE_PROVIDER_DUPLICATE"
  | "RELEASE_VISION_PRIMARY"
  | "RELEASE_VISION_DUPLICATE"
  | "BOARD_REVISION"
  | "TYPED_INPUT_COMMIT"
  | "TRANSCRIPT_CORRECTION"
  | "SUPERSEDE_GENERATION"
  | "PROVIDER_SWITCH"
  | "EVIDENCE_UPDATE"
  | "START_QUEUED_DELIVERY"
  | "BILLING_CURRENT"
  | "BILLING_MISSING"
  | "BILLING_STALE"
  | "BILLING_FUTURE"
  | "BILLING_MALFORMED";

export type CallbackScheduleOperation =
  | "RELEASE_WORKER_PRIMARY"
  | "RELEASE_WORKER_DUPLICATE"
  | "RELEASE_VERIFIER_PRIMARY"
  | "RELEASE_VERIFIER_DUPLICATE"
  | "TRANSCRIPT_CORRECTION"
  | "BOARD_REVISION"
  | "RESTART"
  | "WORKER_TAMPERED"
  | "WORKER_MISCORRELATED"
  | "VERIFIER_TAMPERED"
  | "VERIFIER_SWITCHED"
  | "VERIFIER_MALFORMED";

export type DeliveryScheduleOperation =
  | "START"
  | "ACK_EXPOSED_PRIMARY"
  | "ACK_EXPOSED_DUPLICATE"
  | "ACK_COMPLETED_PRIMARY"
  | "ACK_COMPLETED_DUPLICATE"
  | "CANCEL_BEFORE_EXPOSURE"
  | "RESTART"
  | "RECONNECT"
  | "BARGE_IN";

export type RecoveryScheduleOperation =
  | "COMMAND_RECOVERY"
  | "RENDERER_RECOVERY"
  | "SHARED_DUPLICATE_RECOVERY"
  | "INDEPENDENT_DUPLICATE_RECOVERY";

export type RestartScheduleOperation =
  | "EVIDENCE_PROGRESSING"
  | "EVIDENCE_COMPLETE"
  | "TRANSCRIPT_CORRECTION"
  | "RESTART"
  | "RELEASE_WORKER_PRIMARY"
  | "RELEASE_WORKER_DUPLICATE"
  | "RELEASE_VERIFIER_PRIMARY"
  | "RELEASE_VERIFIER_DUPLICATE";

const CORE_OPERATIONS: readonly CoreScheduleOperation[] = [
  "RELEASE_PROVIDER_PRIMARY",
  "RELEASE_PROVIDER_DUPLICATE",
  "RELEASE_VISION_PRIMARY",
  "RELEASE_VISION_DUPLICATE",
  "BOARD_REVISION",
  "TYPED_INPUT_COMMIT",
  "TRANSCRIPT_CORRECTION",
  "SUPERSEDE_GENERATION",
  "PROVIDER_SWITCH",
  "EVIDENCE_UPDATE",
  "START_QUEUED_DELIVERY",
  "BILLING_CURRENT",
  "BILLING_MISSING",
  "BILLING_STALE",
  "BILLING_FUTURE",
  "BILLING_MALFORMED"
];

const CALLBACK_OPERATIONS: readonly CallbackScheduleOperation[] = [
  "RELEASE_WORKER_PRIMARY",
  "RELEASE_WORKER_DUPLICATE",
  "RELEASE_VERIFIER_PRIMARY",
  "RELEASE_VERIFIER_DUPLICATE",
  "TRANSCRIPT_CORRECTION",
  "BOARD_REVISION",
  "RESTART",
  "WORKER_TAMPERED",
  "WORKER_MISCORRELATED",
  "VERIFIER_TAMPERED",
  "VERIFIER_SWITCHED",
  "VERIFIER_MALFORMED"
];

const DELIVERY_OPERATIONS: readonly DeliveryScheduleOperation[] = [
  "START",
  "ACK_EXPOSED_PRIMARY",
  "ACK_EXPOSED_DUPLICATE",
  "ACK_COMPLETED_PRIMARY",
  "ACK_COMPLETED_DUPLICATE",
  "CANCEL_BEFORE_EXPOSURE",
  "RESTART",
  "RECONNECT",
  "BARGE_IN"
];

const RECOVERY_OPERATIONS: readonly RecoveryScheduleOperation[] = [
  "COMMAND_RECOVERY",
  "RENDERER_RECOVERY",
  "SHARED_DUPLICATE_RECOVERY",
  "INDEPENDENT_DUPLICATE_RECOVERY"
];

const RESTART_OPERATIONS: readonly RestartScheduleOperation[] = [
  "EVIDENCE_PROGRESSING",
  "EVIDENCE_COMPLETE",
  "TRANSCRIPT_CORRECTION",
  "RESTART",
  "RELEASE_WORKER_PRIMARY",
  "RELEASE_WORKER_DUPLICATE",
  "RELEASE_VERIFIER_PRIMARY",
  "RELEASE_VERIFIER_DUPLICATE"
];

export const coreScheduleArbitrary = fc.shuffledSubarray([...CORE_OPERATIONS], {
  minLength: 7,
  maxLength: CORE_OPERATIONS.length
});

export const callbackScheduleArbitrary = fc.shuffledSubarray([...CALLBACK_OPERATIONS], {
  minLength: 7,
  maxLength: CALLBACK_OPERATIONS.length
});

export const deliveryScheduleArbitrary = fc.shuffledSubarray([...DELIVERY_OPERATIONS], {
  minLength: 5,
  maxLength: DELIVERY_OPERATIONS.length
});

export const restartScheduleArbitrary = fc.shuffledSubarray([...RESTART_OPERATIONS], {
  minLength: 5,
  maxLength: RESTART_OPERATIONS.length
});

export const recoveryScheduleArbitrary = fc.shuffledSubarray([...RECOVERY_OPERATIONS], {
  minLength: RECOVERY_OPERATIONS.length,
  maxLength: RECOVERY_OPERATIONS.length
});

export function propertyParameters(
  suite: string,
  seedOffset: number,
  defaultRuns: number
): {
  readonly numRuns: number;
  readonly seed: number;
  readonly path?: string;
  readonly verbose: 2;
} {
  const numRuns =
    positiveIntegerFromEnvironment("ADVERSARIAL_RUNS")
    ?? VALIDATION_STRESS_RUNS;
  const configuredSeed = integerFromEnvironment("ADVERSARIAL_SEED");
  const seed = configuredSeed
    ?? VALIDATION_STRESS_BASE_SEED + seedOffset;
  void defaultRuns;
  const selectedSuite = process.env.ADVERSARIAL_SUITE;
  const configuredPath = process.env.ADVERSARIAL_PATH?.trim();
  const path = selectedSuite === suite && configuredPath !== undefined && configuredPath.length > 0
    ? configuredPath
    : undefined;

  console.info(
    `[adversarial] suite=${suite} runs=${String(numRuns)} seed=${String(seed)} path=${path ?? "<none>"}`
  );

  return {
    numRuns,
    seed,
    ...(path === undefined ? {} : { path }),
    verbose: 2
  };
}

function positiveIntegerFromEnvironment(name: string): number | undefined {
  const value = integerFromEnvironment(name);
  if (value === undefined) return undefined;
  if (value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function integerFromEnvironment(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
}
