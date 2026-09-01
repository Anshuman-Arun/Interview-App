import { createHash } from "node:crypto";
import {
  TTS_LIMITS,
  TTS_PROTOCOL_VERSION,
  computeTtsChunkBasisHash,
  TtsAudioBeginSchema,
  TtsAudioChunkSchema,
  TtsAudioEndSchema,
  TtsCancelRequestSchema,
  TtsCancellationResultSchema,
  TtsErrorCodeSchema,
  type TtsCancellationResult,
  type TtsErrorCode,
  type TtsStreamMessage,
  type TtsSynthesizeRequest
} from "./tts-protocol.js";
import {
  TtsWorkerError,
  encodePcmF32Le,
  planTtsRequest,
  snapshotAndValidatePcm,
  snapshotSpeechSynthesizer,
  type PlannedTtsRequest,
  type SpeechSynthesizerSnapshot,
  type TtsSegmentSynthesisRequest
} from "./tts-core.js";

export type TtsRequestOutcome = "DONE" | "CANCELLED";

export interface TtsRunSummary {
  readonly requestId: TtsSynthesizeRequest["requestId"];
  readonly requestBasisHash: string;
  readonly outcome: TtsRequestOutcome;
  readonly segmentCount: number;
  readonly emittedChunks: number;
  readonly totalFrames: number;
  readonly totalBytes: number;
  readonly durationMs: number;
}

export interface TtsDiagnosticRecord {
  readonly requestId: string;
  readonly state: "ADMITTED" | "RUNNING" | "CANCELLED" | "DONE" | "ERROR";
  readonly voice: string;
  readonly modelId: string;
  readonly segmentCount: number;
  readonly sampleRate: number;
  readonly durationMs?: number;
  readonly errorCode?: TtsErrorCode;
}

export interface TtsManagerInspection {
  readonly shutdown: boolean;
  readonly activeRequestIds: readonly string[];
  readonly rememberedRequestCount: number;
  readonly retiredInFlightCount: number;
  readonly runtimeReservations: number;
  readonly diagnostics: readonly TtsDiagnosticRecord[];
}

export type TtsMessageSink = (message: TtsStreamMessage) => void | Promise<void>;

interface ActiveRequest {
  readonly plan: PlannedTtsRequest;
  readonly fingerprint: string;
  readonly completion: Promise<TtsRunSummary>;
  readonly resolve: (summary: TtsRunSummary) => void;
  readonly reject: (error: TtsWorkerError) => void;
  readonly cancellation: Promise<void>;
  readonly resolveCancellation: () => void;
  cancelled: boolean;
  modelCallInFlight: boolean;
  sinkCallInFlight: boolean;
  runtimeCancellationCallInFlight: boolean;
  reservationReleased: boolean;
  runtimeCancellation?: Promise<"NOT_NEEDED" | "REQUESTED" | "UNSUPPORTED">;
}

interface RememberedSuccess {
  readonly kind: "SUCCESS";
  readonly fingerprint: string;
  readonly summary: TtsRunSummary;
}

interface RememberedFailure {
  readonly kind: "FAILURE";
  readonly fingerprint: string;
  readonly code: TtsErrorCode;
}

type RememberedRequest = RememberedSuccess | RememberedFailure;

interface RetiredInFlightRequest {
  readonly fingerprint: string;
  readonly summary: TtsRunSummary;
}

interface SegmentRacePcm {
  readonly kind: "PCM";
  readonly value: unknown;
}

interface SegmentRaceError {
  readonly kind: "ERROR";
  readonly error: unknown;
}

interface SegmentRaceCancelled {
  readonly kind: "CANCELLED";
}

type SegmentRaceResult = SegmentRacePcm | SegmentRaceError | SegmentRaceCancelled;

const SAFE_ERROR_MESSAGES: Readonly<Record<TtsErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: "TTS request was rejected",
  UNSUPPORTED_VOICE: "Requested TTS voice is unavailable",
  UNSUPPORTED_LANGUAGE: "Requested TTS language is unavailable",
  UNSUPPORTED_SAMPLE_RATE: "Requested TTS sample rate is unavailable",
  MODEL_UNAVAILABLE: "TTS model is unavailable",
  SYNTHESIS_FAILED: "TTS synthesis failed",
  OUTPUT_INVALID: "TTS model returned invalid audio",
  RESOURCE_LIMIT: "TTS resource limit was exceeded",
  CANCELLED: "TTS request was cancelled",
  REQUEST_ID_CONFLICT: "TTS request identity conflicts with prior content",
  SHUTDOWN: "TTS worker is shut down",
  INTERNAL_ERROR: "TTS worker encountered an internal error"
});

function safeError(error: unknown, fallbackCode: TtsErrorCode): TtsWorkerError {
  try {
    if (error instanceof TtsWorkerError) {
      const parsedCode = TtsErrorCodeSchema.safeParse(error.code);
      if (parsedCode.success) {
        return new TtsWorkerError(parsedCode.data, SAFE_ERROR_MESSAGES[parsedCode.data]);
      }
    }
  } catch {
    // Treat hostile error objects exactly like an unknown backend failure.
  }
  return new TtsWorkerError(fallbackCode, SAFE_ERROR_MESSAGES[fallbackCode]);
}

function requestIdConflict(): TtsWorkerError {
  return new TtsWorkerError("REQUEST_ID_CONFLICT", "TTS requestId was reused with different content");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export class TtsRequestManager {
  private readonly synthesizer: SpeechSynthesizerSnapshot;
  private readonly active = new Map<string, ActiveRequest>();
  private readonly remembered = new Map<string, RememberedRequest>();
  private readonly retiredInFlight = new Map<string, RetiredInFlightRequest>();
  private readonly diagnostics: TtsDiagnosticRecord[] = [];
  private runtimeReservations = 0;
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(synthesizer: unknown) {
    this.synthesizer = snapshotSpeechSynthesizer(synthesizer);
  }

  public run(input: unknown, sink: TtsMessageSink): Promise<TtsRunSummary> {
    if (this.shutdownRequested) {
      return Promise.reject(new TtsWorkerError("SHUTDOWN", "TTS manager is shut down"));
    }

    let plan: PlannedTtsRequest;
    try {
      plan = planTtsRequest(input);
    } catch (error) {
      return Promise.reject(safeError(error, "INTERNAL_ERROR"));
    }

    const requestId = plan.request.requestId;
    const fingerprint = plan.requestBasisHash;
    const retired = this.retiredInFlight.get(requestId);
    if (retired !== undefined) {
      if (retired.fingerprint !== fingerprint) return Promise.reject(requestIdConflict());
      return Promise.resolve(retired.summary);
    }

    const remembered = this.remembered.get(requestId);
    if (remembered !== undefined) {
      if (remembered.fingerprint !== fingerprint) return Promise.reject(requestIdConflict());
      return remembered.kind === "SUCCESS"
        ? Promise.resolve(remembered.summary)
        : Promise.reject(new TtsWorkerError(remembered.code, "TTS request previously failed"));
    }

    const active = this.active.get(requestId);
    if (active !== undefined) {
      return active.fingerprint === fingerprint ? active.completion : Promise.reject(requestIdConflict());
    }

    if (!this.synthesizer.supportedVoices.includes(plan.request.voice)) {
      return Promise.reject(new TtsWorkerError("UNSUPPORTED_VOICE", "Requested TTS voice is unavailable"));
    }
    if (!this.synthesizer.supportedLanguages.includes(plan.request.language)) {
      return Promise.reject(new TtsWorkerError("UNSUPPORTED_LANGUAGE", "Requested TTS language is unavailable"));
    }
    if (!this.synthesizer.supportedSampleRates.includes(plan.request.sampleRate)) {
      return Promise.reject(
        new TtsWorkerError("UNSUPPORTED_SAMPLE_RATE", "Requested TTS sample rate is unavailable")
      );
    }
    if (this.runtimeReservations >= TTS_LIMITS.maxConcurrentRequests) {
      return Promise.reject(new TtsWorkerError("RESOURCE_LIMIT", "TTS concurrency limit reached"));
    }

    let resolveCompletion: ((summary: TtsRunSummary) => void) | undefined;
    let rejectCompletion: ((error: TtsWorkerError) => void) | undefined;
    const completion = new Promise<TtsRunSummary>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    let resolveCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });

    const record: ActiveRequest = {
      plan,
      fingerprint,
      completion,
      resolve: resolveCompletion as (summary: TtsRunSummary) => void,
      reject: rejectCompletion as (error: TtsWorkerError) => void,
      cancellation,
      resolveCancellation: resolveCancellation as () => void,
      cancelled: false,
      modelCallInFlight: false,
      sinkCallInFlight: false,
      runtimeCancellationCallInFlight: false,
      reservationReleased: false
    };
    this.runtimeReservations += 1;
    this.active.set(requestId, record);
    this.rememberDiagnostic(record, "ADMITTED");

    queueMicrotask(() => {
      void this.execute(record, sink);
    });
    return completion;
  }

  public async cancel(input: unknown): Promise<TtsCancellationResult> {
    let parsed: ReturnType<typeof TtsCancelRequestSchema.safeParse>;
    try {
      parsed = TtsCancelRequestSchema.safeParse(input);
    } catch {
      throw new TtsWorkerError("INVALID_REQUEST", "TTS cancellation request failed validation");
    }
    if (!parsed.success) {
      throw new TtsWorkerError("INVALID_REQUEST", "TTS cancellation request failed validation");
    }
    const requestId = parsed.data.requestId;
    const active = this.active.get(requestId);
    if (active === undefined) {
      const retired = this.retiredInFlight.has(requestId);
      const remembered = this.remembered.get(requestId);
      const wasCancelled = retired
        || (remembered?.kind === "SUCCESS" && remembered.summary.outcome === "CANCELLED");
      return TtsCancellationResultSchema.parse({
        protocolVersion: TTS_PROTOCOL_VERSION,
        type: "CANCEL_RESULT",
        requestId,
        accepted: wasCancelled,
        runtimeCancellation: "NOT_NEEDED"
      });
    }

    if (!active.cancelled) {
      active.cancelled = true;
      active.resolveCancellation();
      this.rememberDiagnostic(active, "CANCELLED");
    }

    const runtimeCancellation = await this.requestRuntimeCancellation(active);

    return TtsCancellationResultSchema.parse({
      protocolVersion: TTS_PROTOCOL_VERSION,
      type: "CANCEL_RESULT",
      requestId,
      accepted: true,
      runtimeCancellation
    });
  }

  public shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shutdownRequested = true;
    const shutdownPromise = this.performShutdown();
    this.shutdownPromise = shutdownPromise;
    return shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    const cancellationPromises: Array<Promise<"NOT_NEEDED" | "REQUESTED" | "UNSUPPORTED">> = [];
    const completionPromises: Promise<TtsRunSummary>[] = [];
    for (const record of this.active.values()) {
      completionPromises.push(record.completion);
      if (!record.cancelled) {
        record.cancelled = true;
        record.resolveCancellation();
        this.rememberDiagnostic(record, "CANCELLED");
      }
      cancellationPromises.push(this.requestRuntimeCancellation(record));
    }
    await Promise.all(cancellationPromises);
    await Promise.allSettled(completionPromises);
  }

  public inspect(): TtsManagerInspection {
    return Object.freeze({
      shutdown: this.shutdownRequested,
      activeRequestIds: Object.freeze([...this.active.keys()]),
      rememberedRequestCount: this.remembered.size,
      retiredInFlightCount: this.retiredInFlight.size,
      runtimeReservations: this.runtimeReservations,
      diagnostics: Object.freeze(this.diagnostics.map((item) => Object.freeze({ ...item })))
    });
  }

  private async execute(record: ActiveRequest, sink: TtsMessageSink): Promise<void> {
    const { plan } = record;
    const request = plan.request;
    if (this.isCancelled(record)) {
      this.finishCancelled(record, 0, 0, 0, 0);
      return;
    }

    try {
      this.rememberDiagnostic(record, "RUNNING");
      const beginEmission = await this.emit(record, sink, TtsAudioBeginSchema.parse({
        protocolVersion: TTS_PROTOCOL_VERSION,
        type: "AUDIO_BEGIN",
        requestId: request.requestId,
        requestBasisHash: plan.requestBasisHash,
        normalizedTextHash: plan.normalizedTextHash,
        sequence: 0,
        segmentCount: plan.segments.length,
        sampleRate: request.sampleRate,
        channels: 1,
        sampleFormat: "F32LE",
        model: this.synthesizer.identity
      }));
      if (beginEmission === "CANCELLED" || this.isCancelled(record)) {
        this.finishCancelled(record, 0, 0, 0, 0);
        return;
      }

      let sequence = 1;
      let chunkIndex = 0;
      let totalFrames = 0;
      let totalBytes = 0;
      let totalDurationMs = 0;
      const audioHasher = createHash("sha256");

      for (const segment of plan.segments) {
        if (this.isCancelled(record)) {
          this.finishCancelled(record, chunkIndex, totalFrames, totalBytes, totalDurationMs);
          return;
        }

        const segmentRequest: TtsSegmentSynthesisRequest = {
          requestId: request.requestId,
          segmentIndex: segment.index,
          text: segment.text,
          voice: request.voice,
          speed: request.speed,
          language: request.language,
          sampleRate: request.sampleRate
        };
        const raceResult = await this.synthesizeOrCancel(record, segmentRequest);
        if (raceResult.kind === "CANCELLED" || this.isCancelled(record)) {
          this.finishCancelled(record, chunkIndex, totalFrames, totalBytes, totalDurationMs);
          return;
        }
        if (raceResult.kind === "ERROR") {
          throw new TtsWorkerError("SYNTHESIS_FAILED", SAFE_ERROR_MESSAGES.SYNTHESIS_FAILED);
        }

        const pcm = snapshotAndValidatePcm(raceResult.value, request.sampleRate);
        if (this.isCancelled(record)) {
          this.finishCancelled(record, chunkIndex, totalFrames, totalBytes, totalDurationMs);
          return;
        }

        const nextFrames = totalFrames + pcm.frameCount;
        const nextBytes = totalBytes + pcm.byteLength;
        const nextDurationMs = (nextFrames / request.sampleRate) * 1_000;
        if (nextBytes > TTS_LIMITS.maxPcmBytes || nextDurationMs > TTS_LIMITS.maxOutputDurationMs) {
          throw new TtsWorkerError("RESOURCE_LIMIT", "TTS request exceeded aggregate PCM limits");
        }

        const bytes = encodePcmF32Le(pcm.samples);
        let frameOffset = 0;
        while (frameOffset < pcm.frameCount) {
          if (this.isCancelled(record)) {
            this.finishCancelled(record, chunkIndex, totalFrames, totalBytes, totalDurationMs);
            return;
          }
          if (chunkIndex >= TTS_LIMITS.maxChunks) {
            throw new TtsWorkerError("RESOURCE_LIMIT", "TTS request exceeded the chunk limit");
          }

          const frameCount = Math.min(TTS_LIMITS.maxChunkFrames, pcm.frameCount - frameOffset);
          const byteOffset = frameOffset * 4;
          const chunkBytes = bytes.slice(byteOffset, byteOffset + frameCount * 4);
          const finalInSegment = frameOffset + frameCount === pcm.frameCount;
          const pcmHash = sha256(chunkBytes);
          const chunkBasisHash = computeTtsChunkBasisHash({
            requestBasisHash: plan.requestBasisHash,
            sequence,
            segmentIndex: segment.index,
            segmentHash: segment.textHash,
            chunkIndex,
            finalInSegment,
            sampleRate: request.sampleRate,
            frameCount,
            byteLength: chunkBytes.byteLength,
            pcmHash
          });
          const message = TtsAudioChunkSchema.parse({
            protocolVersion: TTS_PROTOCOL_VERSION,
            type: "AUDIO_CHUNK",
            requestId: request.requestId,
            requestBasisHash: plan.requestBasisHash,
            sequence,
            segmentIndex: segment.index,
            segmentHash: segment.textHash,
            pcmHash,
            chunkBasisHash,
            chunkIndex,
            finalInSegment,
            sampleRate: request.sampleRate,
            channels: 1,
            sampleFormat: "F32LE",
            frameCount,
            byteLength: chunkBytes.byteLength,
            audioBase64: Buffer.from(chunkBytes).toString("base64")
          });
          const chunkEmission = await this.emit(record, sink, message);
          if (chunkEmission === "CANCELLED") {
            this.finishCancelled(record, chunkIndex, totalFrames, totalBytes, totalDurationMs);
            return;
          }
          audioHasher.update(chunkBytes);
          totalFrames += frameCount;
          totalBytes += chunkBytes.byteLength;
          totalDurationMs = (totalFrames / request.sampleRate) * 1_000;
          sequence += 1;
          chunkIndex += 1;
          frameOffset += frameCount;
          if (this.isCancelled(record)) {
            this.finishCancelled(record, chunkIndex, totalFrames, totalBytes, totalDurationMs);
            return;
          }
        }

      }

      if (this.isCancelled(record)) {
        this.finishCancelled(record, chunkIndex, totalFrames, totalBytes, totalDurationMs);
        return;
      }

      const endEmission = await this.emit(record, sink, TtsAudioEndSchema.parse({
        protocolVersion: TTS_PROTOCOL_VERSION,
        type: "AUDIO_END",
        requestId: request.requestId,
        requestBasisHash: plan.requestBasisHash,
        sequence,
        segmentsSynthesized: plan.segments.length,
        totalFrames,
        totalBytes,
        audioHash: audioHasher.digest("hex"),
        durationMs: totalDurationMs,
        sampleRate: request.sampleRate,
        channels: 1,
        sampleFormat: "F32LE",
        model: this.synthesizer.identity
      }));
      if (endEmission === "CANCELLED") {
        this.finishCancelled(record, chunkIndex, totalFrames, totalBytes, totalDurationMs);
        return;
      }

      const summary: TtsRunSummary = Object.freeze({
        requestId: request.requestId,
        requestBasisHash: plan.requestBasisHash,
        outcome: "DONE",
        segmentCount: plan.segments.length,
        emittedChunks: chunkIndex,
        totalFrames,
        totalBytes,
        durationMs: totalDurationMs
      });
      this.active.delete(request.requestId);
      this.releaseReservation(record);
      this.rememberSuccess(record.fingerprint, summary);
      this.rememberDiagnostic(record, "DONE", totalDurationMs);
      record.resolve(summary);
    } catch (error) {
      const safe = safeError(error, "INTERNAL_ERROR");
      this.active.delete(request.requestId);
      this.releaseReservation(record);
      this.rememberFailure(request.requestId, record.fingerprint, safe.code);
      this.rememberDiagnostic(record, "ERROR", undefined, safe.code);
      record.reject(safe);
    }
  }

  private isCancelled(record: ActiveRequest): boolean {
    return record.cancelled;
  }

  private async synthesizeOrCancel(
    record: ActiveRequest,
    request: TtsSegmentSynthesisRequest
  ): Promise<SegmentRaceResult> {
    if (record.modelCallInFlight) {
      throw new TtsWorkerError("INTERNAL_ERROR", "TTS request attempted overlapping model calls");
    }
    record.modelCallInFlight = true;
    const synthesis = Promise.resolve()
      .then(async () => this.synthesizer.synthesize(request))
      .then<SegmentRaceResult, SegmentRaceResult>(
        (value) => {
          this.onModelCallSettled(record);
          return { kind: "PCM", value };
        },
        (error: unknown) => {
          this.onModelCallSettled(record);
          return { kind: "ERROR", error };
        }
      );
    const cancellation = record.cancellation.then<SegmentRaceResult>(() => ({ kind: "CANCELLED" }));
    return Promise.race([synthesis, cancellation]);
  }

  private async emit(
    record: ActiveRequest,
    sink: TtsMessageSink,
    message: TtsStreamMessage
  ): Promise<"EMITTED" | "CANCELLED"> {
    if (this.isCancelled(record)) return "CANCELLED";
    if (record.sinkCallInFlight) {
      throw new TtsWorkerError("INTERNAL_ERROR", "TTS request attempted overlapping sink calls");
    }
    record.sinkCallInFlight = true;
    const sinkAttempt = Promise.resolve()
      .then(async () => sink(message))
      .then<"EMITTED">(
        () => {
          this.onSinkCallSettled(record);
          return "EMITTED";
        },
        () => {
          this.onSinkCallSettled(record);
          throw new TtsWorkerError("INTERNAL_ERROR", "TTS output sink rejected a message");
        }
      );
    return Promise.race([
      sinkAttempt,
      record.cancellation.then<"CANCELLED">(() => "CANCELLED")
    ]);
  }

  private requestRuntimeCancellation(
    record: ActiveRequest
  ): Promise<"NOT_NEEDED" | "REQUESTED" | "UNSUPPORTED"> {
    if (record.runtimeCancellation !== undefined) return record.runtimeCancellation;
    if (!record.modelCallInFlight) {
      const notNeeded = Promise.resolve<"NOT_NEEDED">("NOT_NEEDED");
      record.runtimeCancellation = notNeeded;
      return notNeeded;
    }
    const cancel = this.synthesizer.cancel;
    if (cancel === undefined) {
      const unsupported = Promise.resolve<"UNSUPPORTED">("UNSUPPORTED");
      record.runtimeCancellation = unsupported;
      return unsupported;
    }

    record.runtimeCancellationCallInFlight = true;
    const runtimeAttempt = Promise.resolve()
      .then(async () => cancel(record.plan.request.requestId))
      .then<"REQUESTED" | "UNSUPPORTED", "UNSUPPORTED">(
        (result) => {
          this.onRuntimeCancellationCallSettled(record);
          return result === "REQUESTED" || result === "UNSUPPORTED"
            ? result
            : "UNSUPPORTED";
        },
        () => {
          this.onRuntimeCancellationCallSettled(record);
          return "UNSUPPORTED";
        }
      );
    const bounded = new Promise<"REQUESTED" | "UNSUPPORTED">((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve("REQUESTED");
      }, TTS_LIMITS.maxRuntimeCancellationWaitMs);
      void runtimeAttempt.then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      });
    });
    record.runtimeCancellation = bounded;
    return bounded;
  }

  private finishCancelled(
    record: ActiveRequest,
    emittedChunks: number,
    totalFrames: number,
    totalBytes: number,
    durationMs: number
  ): void {
    const requestId = record.plan.request.requestId;
    if (!this.active.has(requestId)) return;
    const summary: TtsRunSummary = Object.freeze({
      requestId,
      requestBasisHash: record.plan.requestBasisHash,
      outcome: "CANCELLED",
      segmentCount: record.plan.segments.length,
      emittedChunks,
      totalFrames,
      totalBytes,
      durationMs
    });
    this.active.delete(requestId);
    if (record.modelCallInFlight
        || record.sinkCallInFlight
        || record.runtimeCancellationCallInFlight) {
      this.retiredInFlight.set(requestId, {
        fingerprint: record.fingerprint,
        summary
      });
    } else {
      this.releaseReservation(record);
    }
    this.rememberSuccess(record.fingerprint, summary);
    record.resolve(summary);
  }

  private onModelCallSettled(record: ActiveRequest): void {
    record.modelCallInFlight = false;
    this.releaseRetiredReservationIfSettled(record);
  }

  private onSinkCallSettled(record: ActiveRequest): void {
    record.sinkCallInFlight = false;
    this.releaseRetiredReservationIfSettled(record);
  }

  private onRuntimeCancellationCallSettled(record: ActiveRequest): void {
    record.runtimeCancellationCallInFlight = false;
    this.releaseRetiredReservationIfSettled(record);
  }

  private releaseRetiredReservationIfSettled(record: ActiveRequest): void {
    if (!record.cancelled
        || this.active.has(record.plan.request.requestId)
        || record.modelCallInFlight
        || record.sinkCallInFlight
        || record.runtimeCancellationCallInFlight) {
      return;
    }
    this.retiredInFlight.delete(record.plan.request.requestId);
    this.releaseReservation(record);
  }

  private releaseReservation(record: ActiveRequest): void {
    if (record.reservationReleased) return;
    record.reservationReleased = true;
    this.runtimeReservations = Math.max(0, this.runtimeReservations - 1);
  }

  private rememberSuccess(fingerprint: string, summary: TtsRunSummary): void {
    this.remembered.set(summary.requestId, { kind: "SUCCESS", fingerprint, summary });
    this.trimRemembered();
  }

  private rememberFailure(requestId: string, fingerprint: string, code: TtsErrorCode): void {
    this.remembered.set(requestId, { kind: "FAILURE", fingerprint, code });
    this.trimRemembered();
  }

  private trimRemembered(): void {
    while (this.remembered.size > TTS_LIMITS.maxRememberedRequests) {
      const oldest = this.remembered.keys().next().value;
      if (oldest === undefined) break;
      this.remembered.delete(oldest);
    }
  }

  private rememberDiagnostic(
    record: ActiveRequest,
    state: TtsDiagnosticRecord["state"],
    durationMs?: number,
    errorCode?: TtsErrorCode
  ): void {
    const base = {
      requestId: record.plan.request.requestId,
      state,
      voice: record.plan.request.voice,
      modelId: this.synthesizer.identity.modelId,
      segmentCount: record.plan.segments.length,
      sampleRate: record.plan.request.sampleRate
    };
    const diagnostic: TtsDiagnosticRecord = Object.freeze({
      ...base,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(errorCode === undefined ? {} : { errorCode })
    });
    this.diagnostics.push(diagnostic);
    while (this.diagnostics.length > TTS_LIMITS.maxDiagnostics) this.diagnostics.shift();
  }
}
