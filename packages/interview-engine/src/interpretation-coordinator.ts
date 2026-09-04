import { z } from "zod";
import {
  FormalInterpretationRequestSchema,
  InterpretationProviderResultSchema,
  MAX_FORMAL_INTERPRETATION_CANDIDATES,
  MAX_FORMAL_INTERPRETATION_PROTOCOLS,
  MAX_FORMAL_INTERPRETATION_SOURCE_EVENTS,
  RequestIdSchema,
  VerificationResultSchema,
  evidenceKeyIdentity,
  evidenceKeysEqual,
  generationBasesEqual,
  type DeterministicVerifier,
  type FormalInterpretationCandidate,
  type FormalInterpretationRequest,
  type FormalProtocolRef,
  type GenerationBasis,
  type InterpretationProviderResult,
  type RequestId,
  type VerificationResult,
  type VerificationStatus
} from "../../domain/src/index.js";
import { RequestIdConflictError } from "../../persistence/src/index.js";
import { isVerificationBasisStillCompatible } from "./verification-compatibility.js";
import { createCommandEnvelope } from "./envelopes.js";
import { fingerprintFormalInterpretationRequest } from "./formal-interpretation.js";
import {
  FormalProtocolRoutingRegistry,
  type FormalProtocolRouteResolution,
  type FormalProtocolRoutingScope
} from "./formal-protocol-routing.js";
import type { SessionWriter } from "./session-writer.js";
import {
  VerificationCoordinator,
  VerificationWorkItemSchema,
  type FormalInterpretationDiscardReason,
  type VerificationWorkItem
} from "./verification-coordinator.js";

export const DEFAULT_MAX_IN_FLIGHT_INTERPRETATION_REQUESTS = 16 as const;
export const DEFAULT_MAX_CACHED_INTERPRETATION_REQUESTS = 256 as const;
export const MAX_INTERPRETATION_DIAGNOSTICS = 256 as const;
export const MINIMUM_DETERMINISTIC_INTERPRETATION_CONFIDENCE = 1 as const;
export const MAX_FORMAL_INTERPRETATION_PROVIDER_STATEMENT_CHARACTERS = 200_000 as const;
export const MAX_FORMAL_INTERPRETATION_PROVIDER_OUTPUT_BYTES = 512_000 as const;

const InterpretationCoordinatorOptionsSchema = z.object({
  maxInFlight: z.number().int().min(1).max(64).default(DEFAULT_MAX_IN_FLIGHT_INTERPRETATION_REQUESTS),
  maxCachedRequests: z.number().int().min(16).max(1_024).default(DEFAULT_MAX_CACHED_INTERPRETATION_REQUESTS)
}).strict();

export const InterpretationOutcomeStatusSchema = z.enum([
  "ACCEPTED",
  "INVALID_REQUEST",
  "INVALID_PROVIDER_OUTPUT",
  "INVALID_PROPOSAL",
  "AMBIGUOUS",
  "NO_SUPPORTED_INTERPRETATION",
  "UNSUPPORTED_PROTOCOL",
  "STALE",
  "SOURCE_MISMATCH",
  "TARGET_MISMATCH",
  "VERIFIER_UNAVAILABLE",
  "VERIFIER_UNAUTHORIZED",
  "PROVENANCE_UNAVAILABLE",
  "RESOURCE_LIMIT",
  "VERIFICATION_REJECTED"
]);
export type InterpretationOutcomeStatus = z.infer<typeof InterpretationOutcomeStatusSchema>;

export const InterpretationRejectionReasonSchema = z.enum([
  "MALFORMED_REQUEST",
  "REQUEST_ID_CONFLICT",
  "IN_FLIGHT_LIMIT",
  "PROVIDER_IN_FLIGHT_LIMIT",
  "WRITER_CLOSED",
  "SESSION_MISMATCH",
  "SESSION_NOT_ACTIVE",
  "UNKNOWN_GENERATION",
  "GENERATION_NOT_ACTIVE",
  "BASIS_MISMATCH",
  "BASIS_INCOMPATIBLE",
  "BASIS_UNKNOWN",
  "PROBLEM_CHANGED",
  "SOURCE_TURN_MISMATCH",
  "SOURCE_SPAN_MISMATCH",
  "SOURCE_EVENT_MISMATCH",
  "UNSUPPORTED_REQUEST_PROTOCOL",
  "PROVIDER_FAILURE",
  "MALFORMED_PROVIDER_RESULT",
  "RESULT_REQUEST_MISMATCH",
  "CANCELLED",
  "CANDIDATE_SOURCE_MISMATCH",
  "CANDIDATE_TARGET_MISMATCH",
  "PROTOCOL_NOT_ALLOWED",
  "UNSUPPORTED_CANDIDATE_PROTOCOL",
  "VERIFIER_MISSING",
  "VERIFIER_SCOPE_UNAUTHORIZED",
  "STATEMENT_NOT_STRING",
  "STATEMENT_TOO_LARGE",
  "INVALID_JSON",
  "RESOURCE_LIMIT",
  "MALFORMED_INTERPRETATION",
  "PROTOCOL_MISMATCH",
  "CANONICALIZATION_FAILED",
  "NO_INTERPRETATION",
  "AMBIGUOUS_MULTIPLE",
  "INSUFFICIENT_CONFIDENCE",
  "VERIFICATION_ADMISSION_REJECTED",
  "VERIFICATION_RESULT_REJECTED",
  "VERIFICATION_ALREADY_DISCARDED"
]);
export type InterpretationRejectionReason = z.infer<typeof InterpretationRejectionReasonSchema>;

export interface AcceptedInterpretationOutcome {
  readonly status: "ACCEPTED";
  readonly requestId: RequestId;
  readonly candidateId: string;
  readonly protocol: FormalProtocolRef;
  readonly verifier: string;
  readonly verificationRequestId: RequestId;
  readonly verificationStatus: VerificationStatus;
  readonly evidenceCommitted: boolean;
  readonly duplicateVerificationRequest: boolean;
}

export interface RejectedInterpretationOutcome {
  readonly status: Exclude<InterpretationOutcomeStatus, "ACCEPTED">;
  readonly requestId?: RequestId;
  readonly reason: InterpretationRejectionReason;
  readonly candidateCount: number;
}

export type InterpretationExecutionOutcome =
  | AcceptedInterpretationOutcome
  | RejectedInterpretationOutcome;

export const InterpretationDiagnosticSchema = z.object({
  requestId: RequestIdSchema,
  state: z.enum([
    "RECEIVED",
    "PROVIDER_PENDING",
    "ABSTAINED",
    "VERIFICATION_PENDING",
    "COMPLETED",
    "CANCELLED"
  ]),
  candidateCount: z.number().int().nonnegative().max(8),
  protocol: z.string().min(1).max(64).optional(),
  verifier: z.string().min(1).max(128).optional(),
  reason: InterpretationRejectionReasonSchema.optional()
}).strict();
export type InterpretationDiagnostic = z.infer<typeof InterpretationDiagnosticSchema>;

export interface FormalInterpretationProvider {
  readonly interpret: (
    request: FormalInterpretationRequest,
    runtime?: { readonly signal: AbortSignal }
  ) => Promise<unknown>;
}

export type DeterministicInterpretationResponder =
  (request: FormalInterpretationRequest) => unknown;

export class DeterministicFormalInterpretationProvider implements FormalInterpretationProvider {
  private readonly responder?: DeterministicInterpretationResponder;
  private readonly staticResult?: unknown;
  private calls = 0;

  public constructor(resultOrResponder: unknown) {
    if (typeof resultOrResponder === "function") {
      this.responder = resultOrResponder as DeterministicInterpretationResponder;
    } else {
      this.staticResult = resultOrResponder;
    }
  }

  public get callCount(): number {
    return this.calls;
  }

  public async interpret(request: FormalInterpretationRequest): Promise<unknown> {
    this.calls += 1;
    if (this.responder !== undefined) return this.responder(request);
    return structuredClone(this.staticResult);
  }
}

interface RequestRecord {
  readonly fingerprint: string;
  cancelled: boolean;
  dispatchStarted: boolean;
  verificationRequestId?: RequestId;
  settled: boolean;
  readonly cancelSignal: Promise<void>;
  readonly resolveCancel: () => void;
  readonly providerAbortController: AbortController;
  promise: Promise<InterpretationExecutionOutcome>;
}

interface AdmittedCandidate {
  readonly candidateId: string;
  readonly protocol: FormalProtocolRef;
  readonly confidence: number;
  readonly canonicalStatement: string;
  readonly route: Extract<FormalProtocolRouteResolution, { readonly ok: true }>;
}

function failed(
  status: RejectedInterpretationOutcome["status"],
  reason: InterpretationRejectionReason,
  candidateCount: number,
  requestId?: RequestId
): RejectedInterpretationOutcome {
  return {
    status,
    reason,
    candidateCount,
    ...(requestId === undefined ? {} : { requestId })
  };
}

function protocolKey(protocol: FormalProtocolRef): string {
  return `${protocol.protocol}\u0000${String(protocol.version)}`;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameDirectVerificationBasis(
  requestBasis: GenerationBasis,
  persistedBasis: GenerationBasis
): boolean {
  return requestBasis.contextEpoch === persistedBasis.contextEpoch
    && requestBasis.committedInputSequence === persistedBasis.committedInputSequence
    && requestBasis.transcriptRevision === persistedBasis.transcriptRevision
    && requestBasis.problemStateRevision === persistedBasis.problemStateRevision
    && requestBasis.policyRevision === persistedBasis.policyRevision
    && requestBasis.inputEpisodeId === persistedBasis.inputEpisodeId
    && requestBasis.turnId === persistedBasis.turnId;
}


function sameCandidateSource(candidate: FormalInterpretationCandidate, request: FormalInterpretationRequest): boolean {
  return candidate.source.requestId === request.requestId
    && candidate.source.generationId === request.generationId
    && generationBasesEqual(candidate.source.basis, request.basis)
    && candidate.source.sourceRevision === request.source.sourceRevision
    && candidate.source.inputEpisodeId === request.source.inputEpisodeId
    && candidate.source.turnId === request.source.turnId
    && sameStringArray(candidate.source.eventIds, request.source.eventIds)
    && candidate.source.span.start === request.source.span.start
    && candidate.source.span.end === request.source.span.end
    && candidate.source.span.text === request.source.span.text
    && candidate.source.problem.id === request.problem.id
    && candidate.source.problem.version === request.problem.version;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exceedsArrayBound(value: unknown, maximum: number): boolean {
  return Array.isArray(value) && value.length > maximum;
}

function requestExceedsStructuralBounds(input: unknown): boolean {
  const request = objectRecord(input);
  if (request === undefined) return false;
  if (exceedsArrayBound(request.allowedProtocols, MAX_FORMAL_INTERPRETATION_PROTOCOLS)) return true;
  const source = objectRecord(request.source);
  return source !== undefined
    && exceedsArrayBound(source.eventIds, MAX_FORMAL_INTERPRETATION_SOURCE_EVENTS);
}

function providerResultExceedsStructuralBounds(input: unknown): boolean {
  const result = objectRecord(input);
  if (result === undefined || !Array.isArray(result.candidates)) return false;
  if (result.candidates.length > MAX_FORMAL_INTERPRETATION_CANDIDATES) return true;
  let totalStatementCharacters = 0;
  const exceedsCandidateBounds = result.candidates.some((candidate) => {
    const candidateRecord = objectRecord(candidate);
    if (candidateRecord !== undefined && typeof candidateRecord.formalStatement === "string") {
      totalStatementCharacters += candidateRecord.formalStatement.length;
      if (totalStatementCharacters > MAX_FORMAL_INTERPRETATION_PROVIDER_STATEMENT_CHARACTERS) {
        return true;
      }
    }
    const source = candidateRecord === undefined ? undefined : objectRecord(candidateRecord.source);
    return source !== undefined
      && exceedsArrayBound(source.eventIds, MAX_FORMAL_INTERPRETATION_SOURCE_EVENTS);
  });
  return exceedsCandidateBounds;
}

function validatedProviderResultExceedsByteBound(
  result: InterpretationProviderResult
): boolean {
  const serialized = JSON.stringify(result);
  return new TextEncoder().encode(serialized).byteLength
    > MAX_FORMAL_INTERPRETATION_PROVIDER_OUTPUT_BYTES;
}

function mapRouteFailure(
  reason: "UNSUPPORTED_PROTOCOL" | "VERIFIER_UNAVAILABLE" | "VERIFIER_UNAUTHORIZED",
  requestId: RequestId,
  candidateCount: number,
  requestPhase: boolean
): RejectedInterpretationOutcome {
  switch (reason) {
    case "UNSUPPORTED_PROTOCOL":
      return failed(
        "UNSUPPORTED_PROTOCOL",
        requestPhase ? "UNSUPPORTED_REQUEST_PROTOCOL" : "UNSUPPORTED_CANDIDATE_PROTOCOL",
        candidateCount,
        requestId
      );
    case "VERIFIER_UNAVAILABLE":
      return failed("VERIFIER_UNAVAILABLE", "VERIFIER_MISSING", candidateCount, requestId);
    case "VERIFIER_UNAUTHORIZED":
      return failed("VERIFIER_UNAUTHORIZED", "VERIFIER_SCOPE_UNAUTHORIZED", candidateCount, requestId);
  }
}

function mapStatementFailure(
  reason:
    | "STATEMENT_NOT_STRING"
    | "STATEMENT_TOO_LARGE"
    | "INVALID_JSON"
    | "RESOURCE_LIMIT"
    | "MALFORMED_INTERPRETATION"
    | "PROTOCOL_MISMATCH"
    | "CANONICALIZATION_FAILED",
  requestId: RequestId,
  candidateCount: number
): RejectedInterpretationOutcome {
  if (reason === "RESOURCE_LIMIT" || reason === "STATEMENT_TOO_LARGE") {
    return failed("RESOURCE_LIMIT", reason, candidateCount, requestId);
  }
  return failed("INVALID_PROPOSAL", reason, candidateCount, requestId);
}

export class InterpretationCoordinator {
  private readonly verification: VerificationCoordinator;
  private readonly router: FormalProtocolRoutingRegistry;
  private readonly maxInFlight: number;
  private readonly requestAdmission:
    | ((request: FormalInterpretationRequest) => boolean)
    | undefined;
  private readonly candidateAdmission:
    | ((
        request: FormalInterpretationRequest,
        candidate: FormalInterpretationCandidate
      ) => boolean)
    | undefined;
  private readonly maxCachedRequests: number;
  private readonly records = new Map<RequestId, RequestRecord>();
  private readonly diagnostics: InterpretationDiagnostic[] = [];
  private activeProviderInvocations = 0;

  public constructor(
    private readonly writer: SessionWriter,
    private readonly provider: FormalInterpretationProvider,
    scopes: readonly FormalProtocolRoutingScope[],
    input?: {
      readonly router?: FormalProtocolRoutingRegistry;
      readonly maxInFlight?: number;
      readonly maxCachedRequests?: number;
      readonly requestAdmission?: (
        request: FormalInterpretationRequest
      ) => boolean;
      readonly candidateAdmission?: (
        request: FormalInterpretationRequest,
        candidate: FormalInterpretationCandidate
      ) => boolean;
    }
  ) {
    const options = InterpretationCoordinatorOptionsSchema.parse({
      ...(input?.maxInFlight === undefined ? {} : { maxInFlight: input.maxInFlight }),
      ...(input?.maxCachedRequests === undefined ? {} : { maxCachedRequests: input.maxCachedRequests })
    });
    this.maxInFlight = options.maxInFlight;
    this.maxCachedRequests = options.maxCachedRequests;
    this.requestAdmission = input?.requestAdmission;
    this.candidateAdmission = input?.candidateAdmission;
    this.router = input?.router ?? new FormalProtocolRoutingRegistry(scopes);
    this.verification = new VerificationCoordinator(writer, scopes);
  }

  public getDiagnostics(): readonly InterpretationDiagnostic[] {
    return this.diagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  public hasActiveWork(): boolean {
    if (this.activeProviderInvocations > 0) return true;
    return [...this.records.values()].some((record) => !record.settled);
  }

  public cancel(requestIdInput: unknown): boolean {
    const parsed = RequestIdSchema.safeParse(requestIdInput);
    if (!parsed.success) return false;
    const record = this.records.get(parsed.data);
    if (record === undefined || record.settled || record.dispatchStarted) return false;
    record.cancelled = true;
    record.resolveCancel();
    record.providerAbortController.abort();
    return true;
  }

  /**
   * Supersede analysis even after deterministic dispatch has started. The
   * verifier may finish locally, but its result will not be admitted.
   */
  public abandon(requestIdInput: unknown): boolean {
    const parsed = RequestIdSchema.safeParse(requestIdInput);
    if (!parsed.success) return false;
    const record = this.records.get(parsed.data);
    if (record === undefined || record.settled) return false;
    record.cancelled = true;
    record.resolveCancel();
    record.providerAbortController.abort();
    if (record.verificationRequestId !== undefined) {
      void this.verification.discardPendingVerification({
        verificationRequestId: record.verificationRequestId,
        reason: "FORMAL_INTERPRETATION_ABANDONED"
      }).catch(() => undefined);
    }
    return true;
  }

  public interpretAndVerify(input: unknown): Promise<InterpretationExecutionOutcome> {
    let requestExceedsBounds: boolean;
    try {
      requestExceedsBounds = requestExceedsStructuralBounds(input);
    } catch {
      return Promise.resolve(failed("INVALID_REQUEST", "MALFORMED_REQUEST", 0));
    }
    if (requestExceedsBounds) {
      return Promise.resolve(failed("RESOURCE_LIMIT", "RESOURCE_LIMIT", 0));
    }
    let parsed: ReturnType<typeof FormalInterpretationRequestSchema.safeParse>;
    try {
      parsed = FormalInterpretationRequestSchema.safeParse(input);
    } catch {
      return Promise.resolve(failed("INVALID_REQUEST", "MALFORMED_REQUEST", 0));
    }
    if (!parsed.success) {
      return Promise.resolve(failed("INVALID_REQUEST", "MALFORMED_REQUEST", 0));
    }
    const request = parsed.data;
    let fingerprint: string;
    try {
      fingerprint = fingerprintFormalInterpretationRequest(request);
    } catch {
      return Promise.resolve(failed("INVALID_REQUEST", "MALFORMED_REQUEST", 0, request.requestId));
    }

    const existing = this.records.get(request.requestId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve(failed("INVALID_REQUEST", "REQUEST_ID_CONFLICT", 0, request.requestId));
      }
      return existing.promise;
    }

    const inFlight = [...this.records.values()].filter((record) => !record.settled).length;
    if (inFlight >= this.maxInFlight) {
      return Promise.resolve(failed("RESOURCE_LIMIT", "IN_FLIGHT_LIMIT", 0, request.requestId));
    }

    let resolveCancel: (() => void) | undefined;
    const cancelSignal = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    if (resolveCancel === undefined) throw new Error("Cancellation signal initialization failed");
    const record: RequestRecord = {
      fingerprint,
      cancelled: false,
      dispatchStarted: false,
      settled: false,
      cancelSignal,
      resolveCancel,
      providerAbortController: new AbortController(),
      promise: Promise.resolve(failed("INVALID_REQUEST", "MALFORMED_REQUEST", 0, request.requestId))
    };
    this.records.set(request.requestId, record);
    this.addDiagnostic({ requestId: request.requestId, state: "RECEIVED", candidateCount: 0 });

    record.promise = this.run(request, record)
      .finally(() => {
        record.settled = true;
        this.trimCache();
      });
    return record.promise;
  }

  private async run(
    request: FormalInterpretationRequest,
    record: RequestRecord
  ): Promise<InterpretationExecutionOutcome> {
    const currentFailure = this.checkCurrentRequest(request, 0, true);
    if (currentFailure !== undefined) return this.finishFailure(currentFailure);

    const recovered = await this.resumePersistedDirectVerification(request, record);
    if (recovered !== undefined) return recovered;

    for (const protocol of request.allowedProtocols) {
      const route = this.router.resolve(protocol, request.target);
      if (!route.ok) return this.finishFailure(mapRouteFailure(route.reason, request.requestId, 0, true));
    }

    if (this.requestAdmission !== undefined) {
      let admitted = false;
      try {
        admitted = this.requestAdmission(
          deepFreeze(structuredClone(request))
        );
      } catch {
        admitted = false;
      }
      if (!admitted) {
        return this.finishFailure(failed(
          "NO_SUPPORTED_INTERPRETATION",
          "NO_INTERPRETATION",
          0,
          request.requestId
        ));
      }
    }

    if (this.isCancelled(record)) {
      return this.finishFailure(failed("STALE", "CANCELLED", 0, request.requestId));
    }

    if (this.activeProviderInvocations >= this.maxInFlight) {
      return this.finishFailure(failed(
        "RESOURCE_LIMIT",
        "PROVIDER_IN_FLIGHT_LIMIT",
        0,
        request.requestId
      ));
    }
    this.activeProviderInvocations += 1;
    this.addDiagnostic({
      requestId: request.requestId,
      state: "PROVIDER_PENDING",
      candidateCount: 0
    });

    const providerWork = Promise.resolve()
      .then(() => this.provider.interpret(
        deepFreeze(structuredClone(request)),
        { signal: record.providerAbortController.signal }
      ))
      .then(
        (value) => ({ kind: "RESULT" as const, value }),
        () => ({ kind: "ERROR" as const })
      )
      .finally(() => {
        this.activeProviderInvocations -= 1;
      });
    const providerRace = await Promise.race([
      providerWork,
      record.cancelSignal.then(() => ({ kind: "CANCELLED" as const }))
    ]);
    if (providerRace.kind === "CANCELLED" || this.isCancelled(record)) {
      return this.finishFailure(failed("STALE", "CANCELLED", 0, request.requestId));
    }
    if (providerRace.kind === "ERROR") {
      return this.finishFailure(failed("INVALID_PROVIDER_OUTPUT", "PROVIDER_FAILURE", 0, request.requestId));
    }
    const rawResult: unknown = providerRace.value;

    let providerResultExceedsBounds: boolean;
    try {
      providerResultExceedsBounds = providerResultExceedsStructuralBounds(rawResult);
    } catch {
      return this.finishFailure(failed(
        "INVALID_PROVIDER_OUTPUT",
        "MALFORMED_PROVIDER_RESULT",
        0,
        request.requestId
      ));
    }
    if (providerResultExceedsBounds) {
      return this.finishFailure(failed(
        "RESOURCE_LIMIT",
        "RESOURCE_LIMIT",
        MAX_FORMAL_INTERPRETATION_CANDIDATES,
        request.requestId
      ));
    }
    let providerResult: ReturnType<typeof InterpretationProviderResultSchema.safeParse>;
    try {
      providerResult = InterpretationProviderResultSchema.safeParse(rawResult);
    } catch {
      return this.finishFailure(failed(
        "INVALID_PROVIDER_OUTPUT",
        "MALFORMED_PROVIDER_RESULT",
        0,
        request.requestId
      ));
    }
    if (!providerResult.success) {
      return this.finishFailure(failed(
        "INVALID_PROVIDER_OUTPUT",
        "MALFORMED_PROVIDER_RESULT",
        0,
        request.requestId
      ));
    }
    if (validatedProviderResultExceedsByteBound(providerResult.data)) {
      return this.finishFailure(failed(
        "RESOURCE_LIMIT",
        "RESOURCE_LIMIT",
        providerResult.data.candidates.length,
        request.requestId
      ));
    }
    if (providerResult.data.requestId !== request.requestId) {
      return this.finishFailure(failed(
        "SOURCE_MISMATCH",
        "RESULT_REQUEST_MISMATCH",
        providerResult.data.candidates.length,
        request.requestId
      ));
    }

    const candidateCount = providerResult.data.candidates.length;
    const lateFailure = this.checkCurrentRequest(request, candidateCount);
    if (lateFailure !== undefined) return this.finishFailure(lateFailure);
    if (candidateCount === 0) {
      return this.finishFailure(failed(
        "NO_SUPPORTED_INTERPRETATION",
        "NO_INTERPRETATION",
        0,
        request.requestId
      ));
    }

    const allowed = new Set(request.allowedProtocols.map(protocolKey));
    const admitted = new Map<string, AdmittedCandidate>();

    for (const candidate of providerResult.data.candidates) {
      if (!sameCandidateSource(candidate, request)) {
        return this.finishFailure(failed(
          "SOURCE_MISMATCH",
          "CANDIDATE_SOURCE_MISMATCH",
          candidateCount,
          request.requestId
        ));
      }
      if (!evidenceKeysEqual(candidate.target, request.target)) {
        return this.finishFailure(failed(
          "TARGET_MISMATCH",
          "CANDIDATE_TARGET_MISMATCH",
          candidateCount,
          request.requestId
        ));
      }
      if (!allowed.has(protocolKey(candidate.protocol))) {
        return this.finishFailure(failed(
          "UNSUPPORTED_PROTOCOL",
          "PROTOCOL_NOT_ALLOWED",
          candidateCount,
          request.requestId
        ));
      }

      const route = this.router.resolve(candidate.protocol, request.target);
      if (!route.ok) {
        return this.finishFailure(mapRouteFailure(route.reason, request.requestId, candidateCount, false));
      }

      const statement = this.router.validateStatement(route, candidate.formalStatement);
      if (!statement.ok) {
        return this.finishFailure(mapStatementFailure(statement.reason, request.requestId, candidateCount));
      }

      if (this.candidateAdmission !== undefined) {
        let candidateAdmitted = false;
        try {
          candidateAdmitted = this.candidateAdmission(
            deepFreeze(structuredClone(request)),
            deepFreeze(structuredClone(candidate))
          );
        } catch {
          candidateAdmitted = false;
        }
        if (!candidateAdmitted) continue;
      }

      const normalizedKey = `[${JSON.stringify(protocolKey(candidate.protocol))},${evidenceKeyIdentity(candidate.target)},${JSON.stringify(statement.canonicalStatement)}]`;
      const existing = admitted.get(normalizedKey);
      if (existing === undefined) {
        admitted.set(normalizedKey, {
          candidateId: candidate.candidateId,
          protocol: candidate.protocol,
          confidence: candidate.confidence,
          canonicalStatement: statement.canonicalStatement,
          route
        });
      } else {
        admitted.set(normalizedKey, {
          ...existing,
          candidateId: candidate.candidateId < existing.candidateId ? candidate.candidateId : existing.candidateId,
          confidence: Math.min(existing.confidence, candidate.confidence)
        });
      }
    }

    if (admitted.size === 0) {
      return this.finishFailure(failed(
        "NO_SUPPORTED_INTERPRETATION",
        "NO_INTERPRETATION",
        0,
        request.requestId
      ));
    }
    if (admitted.size !== 1) {
      return this.finishFailure(failed(
        "AMBIGUOUS",
        "AMBIGUOUS_MULTIPLE",
        admitted.size,
        request.requestId
      ));
    }
    const candidate = admitted.values().next().value;
    if (candidate === undefined) {
      return this.finishFailure(failed(
        "NO_SUPPORTED_INTERPRETATION",
        "NO_INTERPRETATION",
        0,
        request.requestId
      ));
    }
    if (candidate.confidence < MINIMUM_DETERMINISTIC_INTERPRETATION_CONFIDENCE) {
      return this.finishFailure(failed(
        "NO_SUPPORTED_INTERPRETATION",
        "INSUFFICIENT_CONFIDENCE",
        1,
        request.requestId
      ));
    }

    const beforeDispatchFailure = this.checkCurrentRequest(request, candidateCount);
    if (beforeDispatchFailure !== undefined) return this.finishFailure(beforeDispatchFailure);
    if (this.isCancelled(record)) {
      return this.finishFailure(failed("STALE", "CANCELLED", candidateCount, request.requestId));
    }

    const verifier = this.router.createVerifier(candidate.route);
    if (verifier === undefined) {
      return this.finishFailure(failed(
        "VERIFIER_UNAVAILABLE",
        "VERIFIER_MISSING",
        candidateCount,
        request.requestId
      ));
    }

    record.dispatchStarted = true;
    this.addDiagnostic({
      requestId: request.requestId,
      state: "VERIFICATION_PENDING",
      candidateCount,
      protocol: candidate.protocol.protocol,
      verifier: candidate.route.definition.verifier
    });

    let workItem: VerificationWorkItem;
    let duplicateVerificationRequest: boolean;
    try {
      if (request.generationId === undefined) {
        const admitted = await this.verification.requestVerification({
          inputEpisodeId: request.source.inputEpisodeId,
          turnId: request.source.turnId,
          verifier: candidate.route.definition.verifier,
          candidateFormalInterpretation: candidate.canonicalStatement,
          interpretationConfidence: candidate.confidence,
          evidenceKey: request.target,
          expectedProblemVersion: request.problem.version,
          boardRevisionIndependent: true,
          envelope: createCommandEnvelope({
            sessionId: request.sessionId,
            producer: "interpretation-coordinator",
            requestId: request.requestId,
            correlationId: request.requestId,
            inputEpisodeId: request.source.inputEpisodeId,
            turnId: request.source.turnId,
            contextEpoch: request.basis.contextEpoch,
            sourceRevision: request.source.sourceRevision
          })
        });
        workItem = admitted.value;
        duplicateVerificationRequest = admitted.duplicate;
      } else {
        const admitted = await this.verification.requestVerificationFromProposal({
          envelope: createCommandEnvelope({
            sessionId: request.sessionId,
            producer: "interpretation-coordinator",
            requestId: request.requestId,
            correlationId: request.requestId,
            generationId: request.generationId,
            inputEpisodeId: request.source.inputEpisodeId,
            turnId: request.source.turnId,
            contextEpoch: request.basis.contextEpoch,
            sourceRevision: request.source.sourceRevision
          }),
          proposal: {
            candidateFormalInterpretation: candidate.canonicalStatement,
            interpretationConfidence: candidate.confidence
          },
          verifier: candidate.route.definition.verifier,
          evidenceKey: request.target,
          expectedProblemVersion: request.problem.version,
          sourceRequestFingerprint: record.fingerprint
        });
        if (!admitted.value.accepted) {
          return this.finishFailure(this.mapVerificationAdmissionFailure(
            admitted.value.reason,
            request.requestId,
            candidateCount
          ));
        }
        workItem = admitted.value.workItem;
        duplicateVerificationRequest = admitted.duplicate;
      }
    } catch (error) {
      if (error instanceof RequestIdConflictError) {
        return this.finishFailure(failed(
          "INVALID_REQUEST",
          "REQUEST_ID_CONFLICT",
          candidateCount,
          request.requestId
        ));
      }
      if (this.writer.isClosed()) {
        return this.finishFailure(failed("STALE", "WRITER_CLOSED", candidateCount, request.requestId));
      }
      return this.finishFailure(failed(
        "VERIFICATION_REJECTED",
        "VERIFICATION_ADMISSION_REJECTED",
        candidateCount,
        request.requestId
      ));
    }

    record.verificationRequestId = workItem.verificationRequestId;
    if (this.isCancelled(record)) {
      await this.discardPendingVerification(record, "FORMAL_INTERPRETATION_CANCELLED");
      return this.finishFailure(failed("STALE", "CANCELLED", candidateCount, request.requestId));
    }

    const persisted = this.writer.getState().verificationRequests[workItem.verificationRequestId];
    if (duplicateVerificationRequest && persisted?.status === "ACCEPTED" && persisted.result !== undefined) {
      const outcome: AcceptedInterpretationOutcome = {
        status: "ACCEPTED",
        requestId: request.requestId,
        candidateId: candidate.candidateId,
        protocol: candidate.protocol,
        verifier: candidate.route.definition.verifier,
        verificationRequestId: workItem.verificationRequestId,
        verificationStatus: persisted.result.status,
        evidenceCommitted: persisted.result.status === "VERIFIED",
        duplicateVerificationRequest: true
      };
      this.finishAccepted(outcome, candidateCount);
      return outcome;
    }
    if (duplicateVerificationRequest && persisted?.status === "DISCARDED") {
      return this.finishFailure(failed(
        "VERIFICATION_REJECTED",
        "VERIFICATION_ALREADY_DISCARDED",
        candidateCount,
        request.requestId
      ));
    }

    const supplied = await this.executeVerifier(verifier, workItem);
    if (this.isCancelled(record)) {
      await this.discardPendingVerification(record, "FORMAL_INTERPRETATION_CANCELLED");
      return this.finishFailure(failed("STALE", "CANCELLED", candidateCount, request.requestId));
    }
    const afterVerifierFailure = this.checkCurrentRequest(request, candidateCount);
    if (afterVerifierFailure !== undefined) {
      await this.discardPendingVerification(record, "FORMAL_INTERPRETATION_STALE");
      return this.finishFailure(afterVerifierFailure);
    }
    let verificationResult;
    try {
      verificationResult = await this.verification.processResult({
        envelope: createCommandEnvelope({
          sessionId: request.sessionId,
          producer: "interpretation-coordinator",
          correlationId: workItem.verificationRequestId,
          inputEpisodeId: request.source.inputEpisodeId,
          turnId: request.source.turnId,
          contextEpoch: workItem.basis.contextEpoch,
          sourceRevision: workItem.basis.committedInputSequence
        }),
        result: supplied,
        verifier,
        cancellationRequested: () => this.isCancelled(record)
      });
    } catch {
      await this.discardPendingVerification(record, "FORMAL_INTERPRETATION_RESULT_FAILED");
      return this.finishFailure(failed(
        "VERIFICATION_REJECTED",
        "VERIFICATION_RESULT_REJECTED",
        candidateCount,
        request.requestId
      ));
    }

    if (!verificationResult.value.accepted) {
      if (this.isCancelled(record)) {
        return this.finishFailure(failed("STALE", "CANCELLED", candidateCount, request.requestId));
      }
      return this.finishFailure(failed(
        "VERIFICATION_REJECTED",
        "VERIFICATION_RESULT_REJECTED",
        candidateCount,
        request.requestId
      ));
    }

    const outcome: AcceptedInterpretationOutcome = {
      status: "ACCEPTED",
      requestId: request.requestId,
      candidateId: candidate.candidateId,
      protocol: candidate.protocol,
      verifier: candidate.route.definition.verifier,
      verificationRequestId: workItem.verificationRequestId,
      verificationStatus: verificationResult.value.status,
      evidenceCommitted: verificationResult.value.evidenceCommitted,
      duplicateVerificationRequest
    };
    this.finishAccepted(outcome, candidateCount);
    return outcome;
  }

  private async resumePersistedDirectVerification(
    request: FormalInterpretationRequest,
    record: RequestRecord
  ): Promise<InterpretationExecutionOutcome | undefined> {
    if (request.generationId !== undefined) return undefined;

    const persisted = this.writer.getState().verificationRequests[request.requestId];
    if (persisted === undefined) return undefined;

    if (
      persisted.sourceGenerationId !== undefined
      || persisted.boardRevisionIndependent !== true
      || !evidenceKeysEqual(persisted.evidenceKey, request.target)
      || !sameDirectVerificationBasis(request.basis, persisted.basis)
      || persisted.basis.inputEpisodeId !== request.source.inputEpisodeId
      || persisted.basis.turnId !== request.source.turnId
      || persisted.basis.committedInputSequence !== request.source.sourceRevision
      || persisted.interpretationConfidence < MINIMUM_DETERMINISTIC_INTERPRETATION_CONFIDENCE
    ) {
      return this.finishFailure(failed(
        "INVALID_REQUEST",
        "REQUEST_ID_CONFLICT",
        0,
        request.requestId
      ));
    }

    const matchingRoutes = request.allowedProtocols
      .map((protocol) => this.router.resolve(protocol, request.target))
      .filter((route): route is Extract<FormalProtocolRouteResolution, { readonly ok: true }> =>
        route.ok && route.definition.verifier === persisted.verifier
      );
    if (matchingRoutes.length !== 1 || matchingRoutes[0] === undefined) {
      await this.verification.discardPendingVerification({
        verificationRequestId: request.requestId,
        reason: "FORMAL_INTERPRETATION_RECOVERY_ROUTE_UNAVAILABLE"
      }).catch(() => undefined);
      return this.finishFailure(failed(
        "VERIFIER_UNAVAILABLE",
        "VERIFIER_MISSING",
        0,
        request.requestId
      ));
    }
    const route = matchingRoutes[0];
    const statement = this.router.validateStatement(route, persisted.candidateFormalInterpretation);
    if (!statement.ok) {
      await this.verification.discardPendingVerification({
        verificationRequestId: request.requestId,
        reason: "FORMAL_INTERPRETATION_RECOVERY_STATEMENT_INVALID"
      }).catch(() => undefined);
      return this.finishFailure(mapStatementFailure(statement.reason, request.requestId, 0));
    }
    const verifier = this.router.createVerifier(route);
    if (verifier === undefined) {
      await this.verification.discardPendingVerification({
        verificationRequestId: request.requestId,
        reason: "FORMAL_INTERPRETATION_RECOVERY_VERIFIER_UNAVAILABLE"
      }).catch(() => undefined);
      return this.finishFailure(failed(
        "VERIFIER_UNAVAILABLE",
        "VERIFIER_MISSING",
        0,
        request.requestId
      ));
    }

    const workItem = VerificationWorkItemSchema.parse({
      protocolVersion: 1,
      verificationRequestId: request.requestId,
      verifier: persisted.verifier,
      basis: persisted.basis,
      candidateFormalInterpretation: persisted.candidateFormalInterpretation,
      interpretationConfidence: persisted.interpretationConfidence,
      evidenceKey: persisted.evidenceKey,
      evidenceEventIds: persisted.evidenceEventIds,
      boardRevisionIndependent: true
    });
    record.dispatchStarted = true;
    record.verificationRequestId = workItem.verificationRequestId;
    this.addDiagnostic({
      requestId: request.requestId,
      state: "VERIFICATION_PENDING",
      candidateCount: 0,
      protocol: route.protocol.protocol,
      verifier: route.definition.verifier
    });

    if (persisted.status === "ACCEPTED" && persisted.result !== undefined) {
      const outcome: AcceptedInterpretationOutcome = {
        status: "ACCEPTED",
        requestId: request.requestId,
        candidateId: "persisted-direct-verification",
        protocol: route.protocol,
        verifier: route.definition.verifier,
        verificationRequestId: request.requestId,
        verificationStatus: persisted.result.status,
        evidenceCommitted: persisted.result.status === "VERIFIED",
        duplicateVerificationRequest: true
      };
      this.finishAccepted(outcome, 0);
      return outcome;
    }
    if (persisted.status === "DISCARDED") {
      return this.finishFailure(failed(
        "VERIFICATION_REJECTED",
        "VERIFICATION_ALREADY_DISCARDED",
        0,
        request.requestId
      ));
    }

    const supplied = await this.executeVerifier(verifier, workItem);
    if (this.isCancelled(record)) {
      await this.discardPendingVerification(record, "FORMAL_INTERPRETATION_CANCELLED");
      return this.finishFailure(failed("STALE", "CANCELLED", 0, request.requestId));
    }
    const currentFailure = this.checkCurrentRequest(request, 0);
    if (currentFailure !== undefined) {
      await this.discardPendingVerification(record, "FORMAL_INTERPRETATION_STALE");
      return this.finishFailure(currentFailure);
    }

    let verificationResult;
    try {
      verificationResult = await this.verification.processResult({
        envelope: createCommandEnvelope({
          sessionId: request.sessionId,
          producer: "interpretation-coordinator-recovery",
          correlationId: workItem.verificationRequestId,
          inputEpisodeId: request.source.inputEpisodeId,
          turnId: request.source.turnId,
          contextEpoch: workItem.basis.contextEpoch,
          sourceRevision: workItem.basis.committedInputSequence
        }),
        result: supplied,
        verifier,
        cancellationRequested: () => this.isCancelled(record)
      });
    } catch {
      await this.discardPendingVerification(record, "FORMAL_INTERPRETATION_RECOVERY_RESULT_FAILED");
      return this.finishFailure(failed(
        "VERIFICATION_REJECTED",
        "VERIFICATION_RESULT_REJECTED",
        0,
        request.requestId
      ));
    }

    if (!verificationResult.value.accepted) {
      if (this.isCancelled(record)) {
        return this.finishFailure(failed("STALE", "CANCELLED", 0, request.requestId));
      }
      return this.finishFailure(failed(
        "VERIFICATION_REJECTED",
        "VERIFICATION_RESULT_REJECTED",
        0,
        request.requestId
      ));
    }

    const outcome: AcceptedInterpretationOutcome = {
      status: "ACCEPTED",
      requestId: request.requestId,
      candidateId: "persisted-direct-verification",
      protocol: route.protocol,
      verifier: route.definition.verifier,
      verificationRequestId: request.requestId,
      verificationStatus: verificationResult.value.status,
      evidenceCommitted: verificationResult.value.evidenceCommitted,
      duplicateVerificationRequest: true
    };
    this.finishAccepted(outcome, 0);
    return outcome;
  }

  private async discardPendingVerification(
    record: RequestRecord,
    reason: string
  ): Promise<void> {
    if (record.verificationRequestId === undefined || this.writer.isClosed()) return;
    try {
      await this.verification.discardPendingVerification({
        verificationRequestId: record.verificationRequestId,
        reason
      });
    } catch {
      // Cancellation cleanup is best-effort when the session is concurrently
      // closing; terminal replay remains fail-closed and cannot admit evidence.
    }
  }

  private async executeVerifier(
    verifier: DeterministicVerifier,
    workItem: VerificationWorkItem
  ): Promise<VerificationResult> {
    try {
      return VerificationResultSchema.parse(await verifier.verify(
        workItem.candidateFormalInterpretation,
        workItem.interpretationConfidence
      ));
    } catch {
      return {
        status: "UNRESOLVED",
        interpretationConfidence: workItem.interpretationConfidence,
        verifier: workItem.verifier,
        reason: "VERIFIER_EXECUTION_FAILED: deterministic verifier execution did not return a valid result"
      };
    }
  }

  private isCancelled(record: RequestRecord): boolean {
    return record.cancelled;
  }

  private checkCurrentRequest(
    request: FormalInterpretationRequest,
    candidateCount = 0,
    requireExactInitialBasis = false
  ): RejectedInterpretationOutcome | undefined {
    if (this.writer.isClosed()) {
      return failed("STALE", "WRITER_CLOSED", candidateCount, request.requestId);
    }

    const state = this.writer.getState();
    if (request.sessionId !== state.sessionId) {
      return failed("SOURCE_MISMATCH", "SESSION_MISMATCH", candidateCount, request.requestId);
    }
    if (!state.started || state.status !== "ACTIVE") {
      return failed("STALE", "SESSION_NOT_ACTIVE", candidateCount, request.requestId);
    }
    if (
      state.problem === undefined
      || state.problem.id !== request.problem.id
      || state.problem.version !== request.problem.version
      || request.target.problemId !== state.problem.id
    ) {
      return failed("SOURCE_MISMATCH", "PROBLEM_CHANGED", candidateCount, request.requestId);
    }

    if (request.generationId === undefined && requireExactInitialBasis) {
      if (
        request.basis.contextEpoch !== state.contextEpoch
        || request.basis.committedInputSequence !== state.lastCommittedInputSequence
        || request.basis.transcriptRevision !== state.transcriptRevision
        || request.basis.boardRevision !== state.boardRevision
        || request.basis.problemStateRevision !== state.problemStateRevision
        || request.basis.policyRevision !== state.policyRevision
      ) {
        return failed("SOURCE_MISMATCH", "BASIS_MISMATCH", candidateCount, request.requestId);
      }
    }

    if (request.generationId !== undefined) {
      const generation = state.generations[request.generationId];
      if (generation === undefined) {
        return failed("STALE", "UNKNOWN_GENERATION", candidateCount, request.requestId);
      }
      if (!generationBasesEqual(generation.basis, request.basis)) {
        return failed("SOURCE_MISMATCH", "BASIS_MISMATCH", candidateCount, request.requestId);
      }
      if (generation.status !== "ACTIVE") {
        const sameRequestAlreadyOpened = Object.values(state.verificationRequests).some((verificationRequest) =>
          verificationRequest.sourceGenerationId === request.generationId
          && verificationRequest.sourceProposalRequestId === request.requestId
        );
        if (!sameRequestAlreadyOpened) {
          return failed("STALE", "GENERATION_NOT_ACTIVE", candidateCount, request.requestId);
        }
      }
    }

    const compatibility = isVerificationBasisStillCompatible(
      request.basis,
      state,
      request.generationId === undefined
    );
    if (compatibility === "INCOMPATIBLE") {
      return failed("STALE", "BASIS_INCOMPATIBLE", candidateCount, request.requestId);
    }
    if (compatibility === "UNKNOWN") {
      return failed("STALE", "BASIS_UNKNOWN", candidateCount, request.requestId);
    }

    const turn = state.turns[request.source.turnId];
    if (
      turn === undefined
      || turn.inputEpisodeId !== request.source.inputEpisodeId
      || request.basis.inputEpisodeId !== request.source.inputEpisodeId
      || request.basis.turnId !== request.source.turnId
      || request.source.sourceRevision !== request.basis.committedInputSequence
    ) {
      return failed("SOURCE_MISMATCH", "SOURCE_TURN_MISMATCH", candidateCount, request.requestId);
    }
    if (
      request.source.span.end > turn.studentText.length
      || turn.studentText.slice(request.source.span.start, request.source.span.end) !== request.source.span.text
    ) {
      return failed("SOURCE_MISMATCH", "SOURCE_SPAN_MISMATCH", candidateCount, request.requestId);
    }

    const turnEventId = state.eventIds[turn.committedSequence - 1];
    if (
      turnEventId === undefined
      || request.source.eventIds.length !== 1
      || request.source.eventIds[0] !== turnEventId
    ) {
      return failed("PROVENANCE_UNAVAILABLE", "SOURCE_EVENT_MISMATCH", candidateCount, request.requestId);
    }

    return undefined;
  }

  private mapVerificationAdmissionFailure(
    reason: FormalInterpretationDiscardReason,
    requestId: RequestId,
    candidateCount: number
  ): RejectedInterpretationOutcome {
    switch (reason) {
      case "SESSION_NOT_ACTIVE":
      case "UNKNOWN_GENERATION":
      case "GENERATION_NOT_ACTIVE":
      case "CALLBACK_BASIS_MISMATCH":
      case "COMPATIBILITY_INCOMPATIBLE":
      case "COMPATIBILITY_UNKNOWN":
        return failed("STALE", "VERIFICATION_ADMISSION_REJECTED", candidateCount, requestId);
      case "PROBLEM_SCOPE_MISMATCH":
        return failed("SOURCE_MISMATCH", "PROBLEM_CHANGED", candidateCount, requestId);
      case "EVIDENCE_SCOPE_UNSUPPORTED":
        return failed("TARGET_MISMATCH", "CANDIDATE_TARGET_MISMATCH", candidateCount, requestId);
      case "VERIFIER_SCOPE_UNAUTHORIZED":
        return failed("VERIFIER_UNAUTHORIZED", "VERIFIER_SCOPE_UNAUTHORIZED", candidateCount, requestId);
      case "PROVENANCE_UNAVAILABLE":
        return failed("PROVENANCE_UNAVAILABLE", "SOURCE_EVENT_MISMATCH", candidateCount, requestId);
      case "MISSING_GENERATION_ID":
        return failed("STALE", "UNKNOWN_GENERATION", candidateCount, requestId);
    }
  }

  private finishFailure(outcome: RejectedInterpretationOutcome): RejectedInterpretationOutcome {
    if (outcome.requestId !== undefined) {
      this.addDiagnostic({
        requestId: outcome.requestId,
        state: outcome.reason === "CANCELLED" ? "CANCELLED" : "ABSTAINED",
        candidateCount: Math.min(outcome.candidateCount, 8),
        reason: outcome.reason
      });
    }
    return outcome;
  }

  private finishAccepted(outcome: AcceptedInterpretationOutcome, candidateCount: number): void {
    this.addDiagnostic({
      requestId: outcome.requestId,
      state: "COMPLETED",
      candidateCount: Math.min(candidateCount, 8),
      protocol: outcome.protocol.protocol,
      verifier: outcome.verifier
    });
  }

  private addDiagnostic(input: InterpretationDiagnostic): void {
    const diagnostic = InterpretationDiagnosticSchema.parse(input);
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > MAX_INTERPRETATION_DIAGNOSTICS) {
      this.diagnostics.splice(0, this.diagnostics.length - MAX_INTERPRETATION_DIAGNOSTICS);
    }
  }

  private trimCache(): void {
    if (this.records.size <= this.maxCachedRequests) return;
    for (const [requestId, record] of this.records) {
      if (!record.settled) continue;
      this.records.delete(requestId);
      if (this.records.size <= this.maxCachedRequests) break;
    }
  }
}

export function echoInterpretationCandidateSource(
  request: FormalInterpretationRequest
): InterpretationProviderResult["candidates"][number]["source"] {
  return {
    requestId: request.requestId,
    ...(request.generationId === undefined ? {} : { generationId: request.generationId }),
    basis: request.basis,
    sourceRevision: request.source.sourceRevision,
    inputEpisodeId: request.source.inputEpisodeId,
    turnId: request.source.turnId,
    eventIds: request.source.eventIds,
    span: request.source.span,
    problem: request.problem
  };
}

export function providerResultFor(
  request: FormalInterpretationRequest,
  candidates: InterpretationProviderResult["candidates"]
): InterpretationProviderResult {
  return InterpretationProviderResultSchema.parse({
    protocolVersion: 1,
    requestId: request.requestId,
    candidates
  });
}
