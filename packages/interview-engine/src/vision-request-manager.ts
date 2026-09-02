import { z } from "zod";
import {
  MAX_VISION_OBSERVATIONS,
  VisionAdmissionResultSchema,
  VisionBackendProvenanceSchema,
  VisionDiagnosticSchema,
  VisionInferenceRequestSchema,
  VisionRequestIdSchema,
  type RequestId,
  type VisionAdmissionReason,
  type VisionAdmissionResult,
  type VisionBackendProvenance,
  type VisionDiagnostic,
  type VisionInferenceRequest
} from "../../domain/src/index.js";
import {
  VisionAuthorityViewSchema,
  admitVisionBackendResult,
  assessVisionRequestFreshness,
  type VisionAuthorityView
} from "./vision-admission.js";
import type {
  VisionInferenceBackend,
  VisionInferenceImagePayload
} from "./vision-inference.js";

const ManagerOptionsSchema = z.object({
  maxInFlight: z.number().int().positive().max(64).default(8),
  maxTombstones: z.number().int().positive().max(128).default(64),
  maxDiagnostics: z.number().int().positive().max(256).default(128),
  maxObservationsPerResult: z.number().int().nonnegative().max(MAX_VISION_OBSERVATIONS).default(MAX_VISION_OBSERVATIONS)
}).strict();

export interface VisionRequestManagerOptions {
  readonly authority: (request: Readonly<VisionInferenceRequest>) => VisionAuthorityView;
  readonly maxInFlight?: number;
  readonly maxTombstones?: number;
  readonly maxDiagnostics?: number;
  readonly maxObservationsPerResult?: number;
}

interface ActiveRequest {
  readonly request: VisionInferenceRequest;
  readonly fingerprint: string;
  readonly backend: VisionBackendProvenance;
  readonly backendFingerprint: string;
  readonly controller: AbortController;
  backendStarted: boolean;
  backendSettled: boolean;
  execution?: Promise<VisionAdmissionResult>;
  settleExecution?: (outcome: VisionAdmissionResult) => void;
}

interface Tombstone {
  readonly fingerprint: string;
  readonly backendFingerprint: string;
  readonly outcome: VisionAdmissionResult;
}

export type VisionRequestRegistration =
  | { readonly accepted: true; readonly duplicate: boolean; readonly request: VisionInferenceRequest }
  | { readonly accepted: false; readonly duplicate: boolean; readonly outcome: VisionAdmissionResult };

export interface VisionCancellationResult {
  readonly cancelled: boolean;
  readonly duplicate: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRequestForIdentity(request: VisionInferenceRequest): unknown {
  return {
    ...request,
    region: {
      ...request.region,
      relevantShapeIds: [...request.region.relevantShapeIds].sort(compareText)
    },
    relevantShapeRevisions: [...request.relevantShapeRevisions]
      .sort((left, right) => compareText(left.shapeId, right.shapeId))
  };
}

function requestFingerprint(request: VisionInferenceRequest): string {
  return JSON.stringify(normalizeRequestForIdentity(request));
}

function backendFingerprint(backend: VisionBackendProvenance): string {
  return JSON.stringify(backend);
}

function rejected(requestId: RequestId, reason: VisionAdmissionReason): VisionAdmissionResult {
  return { accepted: false, requestId, reason };
}

function cloneRequest(request: VisionInferenceRequest): VisionInferenceRequest {
  return VisionInferenceRequestSchema.parse(request);
}

function cloneOutcome(outcome: VisionAdmissionResult): VisionAdmissionResult {
  return VisionAdmissionResultSchema.parse(outcome);
}

function imagePayloadMatchesRequest(
  payload: VisionInferenceImagePayload,
  request: VisionInferenceRequest
): boolean {
  try {
    const metadata = payload.metadata;
    return metadata.mimeType === "image/png"
      && Number.isSafeInteger(metadata.width)
      && metadata.width > 0
      && Number.isSafeInteger(metadata.height)
      && metadata.height > 0
      && Number.isSafeInteger(metadata.byteSize)
      && metadata.byteSize > 0
      && metadata.contentDigest === request.snapshotBasis.snapshotHash
      && typeof payload.readBytes === "function";
  } catch {
    return false;
  }
}

export class VisionRequestManager {
  private readonly active = new Map<RequestId, ActiveRequest>();
  private readonly executionReservations = new Map<RequestId, ActiveRequest>();
  private readonly registrationReservations = new Set<RequestId>();
  private readonly tombstones = new Map<RequestId, Tombstone>();
  private readonly diagnosticRecords: VisionDiagnostic[] = [];
  private readonly limits: z.infer<typeof ManagerOptionsSchema>;
  private readonly authorityResolver: VisionRequestManagerOptions["authority"];
  private closed = false;

  public constructor(options: VisionRequestManagerOptions) {
    this.authorityResolver = options.authority;
    this.limits = ManagerOptionsSchema.parse({
      ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
      ...(options.maxTombstones === undefined ? {} : { maxTombstones: options.maxTombstones }),
      ...(options.maxDiagnostics === undefined ? {} : { maxDiagnostics: options.maxDiagnostics }),
      ...(options.maxObservationsPerResult === undefined ? {} : {
        maxObservationsPerResult: options.maxObservationsPerResult
      })
    });
  }

  public get inFlightCount(): number {
    return this.executionReservations.size;
  }

  private isClosed(): boolean {
    return this.closed;
  }

  public get tombstoneCount(): number {
    return this.tombstones.size;
  }

  public diagnostics(): readonly VisionDiagnostic[] {
    return this.diagnosticRecords.map((record) => ({ ...record }));
  }

  public register(
    requestInput: unknown,
    backendInput: VisionBackendProvenance
  ): VisionRequestRegistration {
    const request = VisionInferenceRequestSchema.parse(requestInput);
    const backend = VisionBackendProvenanceSchema.parse(backendInput);
    const fingerprint = requestFingerprint(request);
    const expectedBackendFingerprint = backendFingerprint(backend);
    const existing = this.active.get(request.requestId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint || existing.backendFingerprint !== expectedBackendFingerprint) {
        return {
          accepted: false,
          duplicate: true,
          outcome: rejected(request.requestId, "CONFLICTING_REQUEST_ID")
        };
      }
      return { accepted: true, duplicate: true, request: cloneRequest(existing.request) };
    }

    const terminal = this.tombstones.get(request.requestId);
    if (terminal !== undefined) {
      if (terminal.fingerprint !== fingerprint || terminal.backendFingerprint !== expectedBackendFingerprint) {
        return {
          accepted: false,
          duplicate: true,
          outcome: rejected(request.requestId, "CONFLICTING_REQUEST_ID")
        };
      }
      return { accepted: false, duplicate: true, outcome: cloneOutcome(terminal.outcome) };
    }

    if (this.executionReservations.has(request.requestId) || this.registrationReservations.has(request.requestId)) {
      return {
        accepted: false,
        duplicate: true,
        outcome: rejected(request.requestId, "CONFLICTING_REQUEST_ID")
      };
    }

    if (this.closed) {
      return { accepted: false, duplicate: false, outcome: rejected(request.requestId, "MANAGER_SHUTDOWN") };
    }
    if (this.executionReservations.size + this.registrationReservations.size >= this.limits.maxInFlight) {
      return { accepted: false, duplicate: false, outcome: rejected(request.requestId, "RESOURCE_LIMIT") };
    }

    this.registrationReservations.add(request.requestId);
    try {
      const authority = this.readAuthority(request);
      if (this.isClosed()) {
        return { accepted: false, duplicate: false, outcome: rejected(request.requestId, "MANAGER_SHUTDOWN") };
      }
      if (!authority.ok) {
        const outcome = rejected(request.requestId, "FRESHNESS_UNKNOWN");
        this.rememberTombstone(request, fingerprint, expectedBackendFingerprint, outcome);
        this.recordDiagnostic(request, backend, outcome);
        return { accepted: false, duplicate: false, outcome };
      }
      const freshness = assessVisionRequestFreshness(request, authority.value);
      if (!freshness.fresh) {
        const outcome = rejected(request.requestId, freshness.reason);
        this.rememberTombstone(request, fingerprint, expectedBackendFingerprint, outcome);
        this.recordDiagnostic(request, backend, outcome);
        return { accepted: false, duplicate: false, outcome };
      }

      const entry: ActiveRequest = {
        request,
        fingerprint,
        backend,
        backendFingerprint: expectedBackendFingerprint,
        controller: new AbortController(),
        backendStarted: false,
        backendSettled: false
      };
      this.active.set(request.requestId, entry);
      this.executionReservations.set(request.requestId, entry);
      return { accepted: true, duplicate: false, request: cloneRequest(request) };
    } finally {
      this.registrationReservations.delete(request.requestId);
    }
  }

  public submit(
    requestInput: unknown,
    backend: VisionInferenceBackend,
    imagePayload?: VisionInferenceImagePayload
  ): Promise<VisionAdmissionResult> {
    let provenance: VisionBackendProvenance;
    let analyze: VisionInferenceBackend["analyze"];
    try {
      provenance = VisionBackendProvenanceSchema.parse(backend.provenance);
      analyze = backend.analyze.bind(backend);
    } catch {
      const request = VisionInferenceRequestSchema.parse(requestInput);
      return Promise.resolve(rejected(request.requestId, "BACKEND_ERROR"));
    }

    if (imagePayload !== undefined) {
      const request = VisionInferenceRequestSchema.parse(requestInput);
      if (!imagePayloadMatchesRequest(imagePayload, request)) {
        return Promise.resolve(rejected(request.requestId, "SNAPSHOT_MISMATCH"));
      }
    }

    const registration = this.register(requestInput, provenance);
    if (!registration.accepted) return Promise.resolve(registration.outcome);
    const entry = this.active.get(registration.request.requestId);
    if (entry === undefined) {
      return Promise.resolve(rejected(registration.request.requestId, "UNKNOWN_REQUEST"));
    }
    if (entry.execution !== undefined) return entry.execution.then(cloneOutcome);

    let settleExecution!: (outcome: VisionAdmissionResult) => void;
    const execution = new Promise<VisionAdmissionResult>((resolve) => {
      settleExecution = resolve;
    });
    entry.execution = execution;
    entry.settleExecution = settleExecution;

    void Promise.resolve().then(async () => {
      const current = this.active.get(entry.request.requestId);
      if (current !== entry || entry.controller.signal.aborted) {
        return this.outcomeForInactive(entry.request.requestId);
      }

      let rawResult: unknown;
      try {
        const backendRequest = VisionInferenceRequestSchema.parse(entry.request);
        entry.backendStarted = true;
        rawResult = await analyze(backendRequest, {
          signal: entry.controller.signal,
          ...(imagePayload === undefined ? {} : { imagePayload })
        }).finally(() => {
          entry.backendSettled = true;
          this.releaseExecutionSlot(entry);
        });
      } catch {
        entry.backendSettled = true;
        this.releaseExecutionSlot(entry);
        const afterError = this.active.get(entry.request.requestId);
        if (afterError !== entry) return this.outcomeForInactive(entry.request.requestId);
        return this.finalize(entry, rejected(entry.request.requestId, "BACKEND_ERROR"));
      }

      const afterBackend = this.active.get(entry.request.requestId);
      if (afterBackend !== entry) return this.outcomeForInactive(entry.request.requestId);
      return this.admitResult(entry.request.requestId, rawResult);
    }).then(
      (outcome) => this.settle(entry, outcome),
      () => {
        const outcome = this.active.get(entry.request.requestId) === entry
          ? this.finalize(entry, rejected(entry.request.requestId, "BACKEND_ERROR"))
          : this.outcomeForInactive(entry.request.requestId);
        this.settle(entry, outcome);
      }
    ).finally(() => {
      this.releaseExecutionSlot(entry);
    });

    return execution.then(cloneOutcome);
  }

  public admitResult(requestIdInput: RequestId, rawResult: unknown): VisionAdmissionResult {
    const requestId = VisionRequestIdSchema.parse(requestIdInput);
    const terminal = this.tombstones.get(requestId);
    if (terminal !== undefined) return cloneOutcome(terminal.outcome);
    const entry = this.active.get(requestId);
    if (entry === undefined) return rejected(requestId, "UNKNOWN_REQUEST");

    const authority = this.readAuthority(entry.request);
    const outcome = authority.ok
      ? admitVisionBackendResult({
          request: entry.request,
          rawResult,
          authority: authority.value,
          expectedBackend: entry.backend,
          maxObservations: this.limits.maxObservationsPerResult
        })
      : rejected(requestId, "FRESHNESS_UNKNOWN");
    return this.finalize(entry, outcome);
  }

  public cancel(requestIdInput: RequestId): VisionCancellationResult {
    const requestId = VisionRequestIdSchema.parse(requestIdInput);
    const terminal = this.tombstones.get(requestId);
    if (terminal !== undefined) {
      return {
        cancelled: !terminal.outcome.accepted && terminal.outcome.reason === "REQUEST_CANCELLED",
        duplicate: true
      };
    }
    const entry = this.active.get(requestId);
    if (entry === undefined) return { cancelled: false, duplicate: false };

    const outcome = rejected(requestId, "REQUEST_CANCELLED");
    this.finalize(entry, outcome);
    entry.controller.abort();
    return { cancelled: true, duplicate: false };
  }

  public supersedeStaleRequests(): number {
    let superseded = 0;
    for (const entry of [...this.active.values()]) {
      const authority = this.readAuthority(entry.request);
      const freshness = authority.ok
        ? assessVisionRequestFreshness(entry.request, authority.value)
        : { fresh: false as const, reason: "FRESHNESS_UNKNOWN" as const };
      if (freshness.fresh) continue;
      this.finalize(entry, rejected(entry.request.requestId, freshness.reason));
      entry.controller.abort();
      superseded += 1;
    }
    return superseded;
  }

  public shutdown(): number {
    if (this.closed) return 0;
    this.closed = true;
    const entries = [...this.active.values()];
    for (const entry of entries) {
      this.finalize(entry, rejected(entry.request.requestId, "REQUEST_CANCELLED"));
      entry.controller.abort();
    }
    return entries.length;
  }

  private finalize(entry: ActiveRequest, outcome: VisionAdmissionResult): VisionAdmissionResult {
    if (this.active.get(entry.request.requestId) !== entry) {
      const terminal = this.outcomeForInactive(entry.request.requestId);
      this.settle(entry, terminal);
      return terminal;
    }
    const canonical = cloneOutcome(outcome);
    this.active.delete(entry.request.requestId);
    if (!entry.backendStarted || entry.backendSettled) this.releaseExecutionSlot(entry);
    this.rememberTombstone(entry.request, entry.fingerprint, entry.backendFingerprint, canonical);
    this.recordDiagnostic(entry.request, entry.backend, canonical);
    this.settle(entry, canonical);
    return cloneOutcome(canonical);
  }

  private settle(entry: ActiveRequest, outcome: VisionAdmissionResult): void {
    entry.settleExecution?.(cloneOutcome(outcome));
  }

  private releaseExecutionSlot(entry: ActiveRequest): void {
    if (this.executionReservations.get(entry.request.requestId) === entry) {
      this.executionReservations.delete(entry.request.requestId);
    }
  }

  private outcomeForInactive(requestId: RequestId): VisionAdmissionResult {
    const terminal = this.tombstones.get(requestId);
    return terminal === undefined
      ? rejected(requestId, "UNKNOWN_REQUEST")
      : cloneOutcome(terminal.outcome);
  }

  private rememberTombstone(
    request: VisionInferenceRequest,
    fingerprint: string,
    expectedBackendFingerprint: string,
    outcome: VisionAdmissionResult
  ): void {
    this.tombstones.set(request.requestId, {
      fingerprint,
      backendFingerprint: expectedBackendFingerprint,
      outcome: cloneOutcome(outcome)
    });
    while (this.tombstones.size > this.limits.maxTombstones) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
  }

  private recordDiagnostic(
    request: VisionInferenceRequest,
    backend: VisionBackendProvenance,
    outcome: VisionAdmissionResult
  ): void {
    const record = VisionDiagnosticSchema.parse({
      requestId: request.requestId,
      regionId: request.region.regionId,
      sourceBoardRevision: request.sourceBoardRevision,
      outcome: outcome.accepted ? "ACCEPTED" : "REJECTED",
      observationCount: outcome.accepted ? outcome.observations.length : 0,
      backendId: backend.backendId,
      backendVersion: backend.backendVersion,
      ...(outcome.accepted ? {} : { reason: outcome.reason })
    });
    this.diagnosticRecords.push(record);
    while (this.diagnosticRecords.length > this.limits.maxDiagnostics) this.diagnosticRecords.shift();
  }

  private readAuthority(
    request: VisionInferenceRequest
  ): { readonly ok: true; readonly value: VisionAuthorityView } | { readonly ok: false } {
    try {
      const requestSnapshot = VisionInferenceRequestSchema.parse(request);
      const authority = this.authorityResolver(requestSnapshot);
      const parsed = VisionAuthorityViewSchema.safeParse(authority);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
    } catch {
      return { ok: false };
    }
  }
}
