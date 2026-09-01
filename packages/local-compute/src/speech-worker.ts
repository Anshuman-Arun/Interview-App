import { createHash } from "node:crypto";
import {
  newUtteranceId,
  type RequestId,
  type UtteranceId
} from "../../domain/src/index.js";
import {
  DEFAULT_SPEECH_CANCELLATION_TIMEOUT_MS,
  DEFAULT_SPEECH_RECOGNIZER_TIMEOUT_MS,
  DEFAULT_SPEECH_VAD_TIMEOUT_MS,
  MAX_SPEECH_BUFFERED_PCM_BYTES,
  MAX_SPEECH_CANCELLATION_TIMEOUT_MS,
  MAX_SPEECH_CONCURRENT_STREAMS,
  MAX_SPEECH_DIAGNOSTIC_CHARS,
  MAX_SPEECH_DIAGNOSTICS,
  MAX_SPEECH_IN_FLIGHT_REQUESTS,
  MAX_SPEECH_PRE_SPEECH_DURATION_MS,
  MAX_SPEECH_RECOGNIZER_TIMEOUT_MS,
  MAX_SPEECH_REMEMBERED_MESSAGES,
  MAX_SPEECH_VAD_TIMEOUT_MS,
  SpeechCancelRequestSchema,
  SpeechFlushRequestSchema,
  SpeechFrameHeuristicsSchema,
  SourceAudioBasisSchema,
  SpeechModelIdentitySchema,
  SpeechUtteranceIdSchema,
  SpeechWorkerEventSchema,
  type SpeechFrameHeuristics,
  type SpeechModelIdentity,
  type SpeechStreamId,
  type SpeechWorkerErrorCode,
  type SpeechWorkerEvent
} from "./speech-protocol.js";
import {
  advancePcmOrder,
  BoundedPcmBuffer,
  PcmAdmissionError,
  snapshotPcmFrame,
  type PcmFrameSnapshot,
  type PcmOrderState
} from "./speech-pcm.js";
import {
  AdaptiveEndpointingPolicy,
  VoiceActivityStateMachine,
  type EndpointingDecision,
  type VadBackend
} from "./speech-vad.js";
import {
  RecognizerCancellationCapabilitySchema,
  TranscriptResultGate,
  type RecognizerCancellationCapability,
  type SpeechRecognizer
} from "./speech-stt.js";

export class SpeechWorkerCoreError extends Error {
  public constructor(
    public readonly code: SpeechWorkerErrorCode,
    message: string
  ) {
    super(message);
  }
}

interface StreamContext {
  readonly streamId: SpeechStreamId;
  readonly vad: VoiceActivityStateMachine;
  readonly endpointing: AdaptiveEndpointingPolicy;
  readonly buffer: BoundedPcmBuffer;
  processingTail: Promise<void>;
  order: PcmOrderState | undefined;
  utteranceId: UtteranceId | undefined;
  utteranceStartTimestampMs: number | undefined;
  preSpeechElapsedMs: number;
  speechConfirmed: boolean;
  terminal: boolean;
  cancelled: boolean;
  finalizationStarted: boolean;
  recognizing: boolean;
  vadAbort: AbortController | undefined;
  recognitionAbort: AbortController | undefined;
  recognitionRequestId: RequestId | undefined;
}

type RememberedMessage =
  | {
      readonly fingerprint: string;
      readonly kind: "EVENTS";
      readonly events: readonly SpeechWorkerEvent[];
    }
  | {
      readonly fingerprint: string;
      readonly kind: "ERROR";
      readonly code: SpeechWorkerErrorCode;
      readonly message: string;
    };

interface InFlightMessage {
  readonly fingerprint: string;
  readonly token: object;
  readonly promise: Promise<readonly SpeechWorkerEvent[]>;
}

export interface SpeechWorkerCoreOptions {
  readonly vadBackend: VadBackend;
  readonly recognizer: SpeechRecognizer;
  readonly maxConcurrentStreams?: number;
  readonly maxBufferedPcmBytes?: number;
  readonly maxRememberedMessages?: number;
  readonly maxInFlightRequests?: number;
  readonly maxPreSpeechDurationMs?: number;
  readonly vadTimeoutMs?: number;
  readonly recognizerTimeoutMs?: number;
  readonly cancellationTimeoutMs?: number;
  readonly utteranceIdFactory?: () => UtteranceId;
  readonly endpointingFactory?: () => AdaptiveEndpointingPolicy;
  readonly vadStateFactory?: () => VoiceActivityStateMachine;
}

export interface SpeechWorkerDiagnostic {
  readonly code: string;
  readonly streamId?: SpeechStreamId;
  readonly detail?: string;
}

export class SpeechWorkerCore {
  private readonly streams = new Map<SpeechStreamId, StreamContext>();
  private readonly closedStreams = new Set<SpeechStreamId>();
  private readonly messages = new Map<RequestId, RememberedMessage>();
  private readonly inFlightMessages = new Map<RequestId, InFlightMessage>();
  private readonly cancellationReserveClaims = new Set<SpeechStreamId>();
  private readonly diagnostics: SpeechWorkerDiagnostic[] = [];
  private readonly transcriptGate = new TranscriptResultGate();
  private readonly recognizerModelIdentity: SpeechModelIdentity;
  private readonly recognizerCancellationCapability: RecognizerCancellationCapability;
  private readonly maxConcurrentStreams: number;
  private readonly maxBufferedPcmBytes: number;
  private readonly maxRememberedMessages: number;
  private readonly maxInFlightRequests: number;
  private readonly maxPreSpeechDurationMs: number;
  private readonly vadTimeoutMs: number;
  private readonly recognizerTimeoutMs: number;
  private readonly cancellationTimeoutMs: number;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(private readonly options: SpeechWorkerCoreOptions) {
    this.recognizerModelIdentity = SpeechModelIdentitySchema.parse(options.recognizer.modelIdentity);
    this.recognizerCancellationCapability = RecognizerCancellationCapabilitySchema.parse(
      options.recognizer.cancellationCapability
    );

    this.maxConcurrentStreams = boundedPositiveSafeInteger(
      options.maxConcurrentStreams ?? MAX_SPEECH_CONCURRENT_STREAMS,
      MAX_SPEECH_CONCURRENT_STREAMS,
      "maxConcurrentStreams"
    );
    this.maxBufferedPcmBytes = boundedPositiveSafeInteger(
      options.maxBufferedPcmBytes ?? MAX_SPEECH_BUFFERED_PCM_BYTES,
      MAX_SPEECH_BUFFERED_PCM_BYTES,
      "maxBufferedPcmBytes"
    );
    this.maxRememberedMessages = boundedPositiveSafeInteger(
      options.maxRememberedMessages ?? MAX_SPEECH_REMEMBERED_MESSAGES,
      MAX_SPEECH_REMEMBERED_MESSAGES,
      "maxRememberedMessages"
    );
    this.maxInFlightRequests = boundedPositiveSafeInteger(
      options.maxInFlightRequests ?? MAX_SPEECH_IN_FLIGHT_REQUESTS,
      MAX_SPEECH_IN_FLIGHT_REQUESTS,
      "maxInFlightRequests"
    );
    this.maxPreSpeechDurationMs = boundedPositiveSafeInteger(
      options.maxPreSpeechDurationMs ?? MAX_SPEECH_PRE_SPEECH_DURATION_MS,
      MAX_SPEECH_PRE_SPEECH_DURATION_MS,
      "maxPreSpeechDurationMs"
    );
    this.vadTimeoutMs = boundedPositiveSafeInteger(
      options.vadTimeoutMs ?? DEFAULT_SPEECH_VAD_TIMEOUT_MS,
      MAX_SPEECH_VAD_TIMEOUT_MS,
      "vadTimeoutMs"
    );
    this.recognizerTimeoutMs = boundedPositiveSafeInteger(
      options.recognizerTimeoutMs ?? DEFAULT_SPEECH_RECOGNIZER_TIMEOUT_MS,
      MAX_SPEECH_RECOGNIZER_TIMEOUT_MS,
      "recognizerTimeoutMs"
    );
    this.cancellationTimeoutMs = boundedPositiveSafeInteger(
      options.cancellationTimeoutMs ?? DEFAULT_SPEECH_CANCELLATION_TIMEOUT_MS,
      MAX_SPEECH_CANCELLATION_TIMEOUT_MS,
      "cancellationTimeoutMs"
    );
  }

  public getDiagnostics(): readonly SpeechWorkerDiagnostic[] {
    return this.diagnostics.map((item) => ({ ...item }));
  }

  public getActiveStreamCount(): number {
    return this.streams.size;
  }

  public async submitFrame(
    envelopeInput: unknown,
    payload: unknown,
    heuristicsInput: unknown = {}
  ): Promise<readonly SpeechWorkerEvent[]> {
    if (this.shuttingDown) throw new SpeechWorkerCoreError("SHUTTING_DOWN", "Speech worker is shutting down");
    const heuristics = SpeechFrameHeuristicsSchema.safeParse(heuristicsInput);
    if (!heuristics.success) throw new SpeechWorkerCoreError("INVALID_REQUEST", "Speech frame heuristics are invalid");

    let frame: PcmFrameSnapshot;
    try {
      frame = snapshotPcmFrame(envelopeInput, payload);
    } catch (error) {
      throw translatePcmError(error);
    }

    const fingerprint = fingerprintParts(
      JSON.stringify(frame.envelope),
      frame.fingerprint,
      JSON.stringify(heuristics.data)
    );
    return this.runIdempotent(frame.envelope.requestId, fingerprint, async () => {
      if (this.shuttingDown) throw new SpeechWorkerCoreError("SHUTTING_DOWN", "Speech worker is shutting down");
      if (this.closedStreams.has(frame.envelope.streamId)) {
        throw new SpeechWorkerCoreError("STREAM_FINALIZED", "Speech stream has already finalized");
      }

      const context = this.getOrCreateStream(frame.envelope.streamId);
      return this.serialize(context, async () => {
        if (context.terminal || this.closedStreams.has(context.streamId) || this.shuttingDown) return [];
        if (context.finalizationStarted) {
          throw new SpeechWorkerCoreError("STREAM_FINALIZED", "Speech stream finalization has already started");
        }
        return this.processFrame(context, frame, heuristics.data);
      });
    });
  }

  public async flush(input: unknown): Promise<readonly SpeechWorkerEvent[]> {
    if (this.shuttingDown) throw new SpeechWorkerCoreError("SHUTTING_DOWN", "Speech worker is shutting down");
    const parsed = SpeechFlushRequestSchema.safeParse(input);
    if (!parsed.success) throw new SpeechWorkerCoreError("INVALID_REQUEST", "Speech flush request is invalid");
    const request = parsed.data;
    const fingerprint = fingerprintParts(JSON.stringify(request));

    return this.runIdempotent(request.requestId, fingerprint, async () => {
      if (this.shuttingDown) throw new SpeechWorkerCoreError("SHUTTING_DOWN", "Speech worker is shutting down");
      const context = this.streams.get(request.streamId);
      if (context === undefined) {
        throw new SpeechWorkerCoreError(
          this.closedStreams.has(request.streamId) ? "STREAM_FINALIZED" : "STREAM_NOT_FOUND",
          this.closedStreams.has(request.streamId) ? "Speech stream has already finalized" : "Speech stream does not exist"
        );
      }

      return this.serialize(context, async () => {
        if (context.terminal || this.closedStreams.has(context.streamId) || this.shuttingDown) return [];
        if (context.finalizationStarted) {
          throw new SpeechWorkerCoreError("STREAM_FINALIZED", "Speech stream finalization has already started");
        }

        const decision = this.endpointDecision(context, { explicitFlush: true });
        if (decision.kind === "DISCARD") {
          const events = [this.event(request.requestId, request.streamId, {
            type: "UTTERANCE_DISCARDED",
            ...(context.utteranceId === undefined ? {} : { utteranceId: context.utteranceId }),
            reason: decision.reason
          })];
          this.abandonStream(context);
          return events;
        }
        if (decision.kind === "FINALIZE") {
          context.finalizationStarted = true;
          return this.finalizeAndRecognize(context, request.requestId, decision.reason);
        }
        return [];
      });
    });
  }

  public async cancel(input: unknown): Promise<readonly SpeechWorkerEvent[]> {
    const parsed = SpeechCancelRequestSchema.safeParse(input);
    if (!parsed.success) throw new SpeechWorkerCoreError("INVALID_REQUEST", "Speech cancellation request is invalid");
    const request = parsed.data;
    const fingerprint = fingerprintParts(JSON.stringify(request));

    const cancellationReserveStreamId = this.streams.has(request.streamId) ? request.streamId : undefined;
    return this.runIdempotent(request.requestId, fingerprint, async () => {
      const context = this.streams.get(request.streamId);
      let cancellation: "RUNTIME_ABORT_REQUESTED" | "SUPPRESS_LATE_RESULT_ONLY" | "NOT_RECOGNIZING" = "NOT_RECOGNIZING";
      let recognitionRequestId: RequestId | undefined;

      if (context !== undefined) {
        context.cancelled = true;
        context.terminal = true;
        context.vadAbort?.abort();
        context.recognitionAbort?.abort();
        recognitionRequestId = context.recognitionRequestId;
        if (context.recognizing) cancellation = "SUPPRESS_LATE_RESULT_ONLY";
        if (!context.recognizing) safeCancelVad(context.vad);
        context.buffer.clear();
        this.streams.delete(request.streamId);
      }
      this.rememberClosedStream(request.streamId);

      if (context?.recognizing === true
          && recognitionRequestId !== undefined
          && this.recognizerCancellationCapability === "RUNTIME_ABORT"
          && this.options.recognizer.cancel !== undefined) {
        if (await this.attemptRecognizerCancel(recognitionRequestId, request.streamId)) {
          cancellation = "RUNTIME_ABORT_REQUESTED";
        }
      }

      return [this.event(request.requestId, request.streamId, {
        type: "SPEECH_CANCELLED",
        cancellation
      })];
    }, cancellationReserveStreamId);
  }

  public shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shuttingDown = true;
    const shutdown = this.performShutdown();
    this.shutdownPromise = shutdown;
    return shutdown;
  }

  private async performShutdown(): Promise<void> {
    const cancellations: Promise<boolean>[] = [];
    for (const context of [...this.streams.values()]) {
      context.cancelled = true;
      context.terminal = true;
      context.vadAbort?.abort();
      context.recognitionAbort?.abort();
      context.buffer.clear();
      if (!context.recognizing) safeCancelVad(context.vad);
      if (context.recognizing
          && context.recognitionRequestId !== undefined
          && this.recognizerCancellationCapability === "RUNTIME_ABORT"
          && this.options.recognizer.cancel !== undefined) {
        cancellations.push(this.attemptRecognizerCancel(context.recognitionRequestId, context.streamId));
      }
      this.streams.delete(context.streamId);
      this.rememberClosedStream(context.streamId);
    }
    await Promise.allSettled(cancellations);
    this.rememberDiagnostic({ code: "SHUTDOWN" });
  }

  private async processFrame(
    context: StreamContext,
    frame: PcmFrameSnapshot,
    heuristics: SpeechFrameHeuristics
  ): Promise<readonly SpeechWorkerEvent[]> {
    try {
      context.order = advancePcmOrder(context.order, frame);
    } catch (error) {
      throw translatePcmError(error);
    }

    if (this.wouldExceedEndpointMaximum(context, frame.durationMs)) {
      const decision = this.endpointDecision(context, {
        forceMaximumDuration: true,
        ...(heuristics.appearsIncomplete === undefined ? {} : { appearsIncomplete: heuristics.appearsIncomplete })
      });
      if (decision.kind === "DISCARD") {
        const events = [this.event(frame.envelope.requestId, frame.envelope.streamId, {
          type: "UTTERANCE_DISCARDED",
          ...(context.utteranceId === undefined ? {} : { utteranceId: context.utteranceId }),
          reason: decision.reason
        })];
        this.abandonStream(context);
        return events;
      }
      if (decision.kind === "FINALIZE") {
        context.finalizationStarted = true;
        return this.finalizeAndRecognize(context, frame.envelope.requestId, "MAX_DURATION");
      }
    }

    let stateBefore;
    try {
      stateBefore = context.vad.snapshot().state;
    } catch {
      this.abandonStream(context);
      throw new SpeechWorkerCoreError("INTERNAL_ERROR", "VAD state could not be inspected");
    }

    const vadAbort = new AbortController();
    context.vadAbort = vadAbort;
    let observation;
    try {
      const isolatedVadFrame = snapshotPcmFrame(frame.envelope, frame.bytes);
      observation = await withTimeout(
        Promise.resolve().then(async () => this.options.vadBackend.classify(isolatedVadFrame, vadAbort.signal)),
        this.vadTimeoutMs,
        () => vadAbort.abort()
      );
    } catch (error) {
      if (context.cancelled || context.terminal || this.shuttingDown) return [];
      if (error instanceof OperationTimeoutError) {
        this.abandonStream(context);
        this.rememberDiagnostic({ code: "VAD_TIMEOUT", streamId: context.streamId });
        throw new SpeechWorkerCoreError("VAD_TIMEOUT", "VAD backend timed out");
      }
      if (vadAbort.signal.aborted) return [];
      this.abandonStream(context);
      this.rememberDiagnostic({ code: "VAD_FAILURE", streamId: context.streamId });
      throw new SpeechWorkerCoreError("VAD_FAILURE", "VAD backend failed");
    } finally {
      if (context.vadAbort === vadAbort) context.vadAbort = undefined;
    }
    if (context.cancelled || context.terminal || this.shuttingDown) return [];

    let step;
    try {
      step = context.vad.step(observation.speechProbability, frame.durationMs);
    } catch {
      this.abandonStream(context);
      throw new SpeechWorkerCoreError("VAD_PROTOCOL_ERROR", "VAD backend returned an invalid observation");
    }

    if (!context.speechConfirmed) {
      context.preSpeechElapsedMs += frame.durationMs;
    }
    if (stateBefore === "SILENCE" && (step.state === "POSSIBLE_SPEECH" || step.speechStarted)) {
      context.utteranceStartTimestampMs = frame.envelope.timestampMs;
    }

    if (context.utteranceId === undefined && (step.state === "POSSIBLE_SPEECH" || step.speechStarted)) {
      try {
        context.utteranceId = this.createUtteranceId();
      } catch {
        this.abandonStream(context);
        throw new SpeechWorkerCoreError("INTERNAL_ERROR", "Speech worker could not create a valid utterance identity");
      }
    }

    if (step.speechStarted) context.speechConfirmed = true;
    if (!context.speechConfirmed && context.preSpeechElapsedMs >= this.maxPreSpeechDurationMs) {
      const events = [this.event(frame.envelope.requestId, frame.envelope.streamId, {
        type: "UTTERANCE_DISCARDED",
        ...(context.utteranceId === undefined ? {} : { utteranceId: context.utteranceId }),
        reason: "NO_SPEECH_TIMEOUT"
      })];
      this.abandonStream(context);
      return events;
    }

    const shouldBuffer = stateBefore !== "SILENCE" || step.state !== "SILENCE";
    if (shouldBuffer && !step.falseStart) {
      try {
        context.buffer.append(frame, step.speechClassified);
      } catch (error) {
        const translated = translatePcmError(error);
        if (translated.code === "RESOURCE_LIMIT") this.abandonStream(context);
        throw translated;
      }
    }

    const events: SpeechWorkerEvent[] = [];
    if (step.falseStart) {
      events.push(this.event(frame.envelope.requestId, frame.envelope.streamId, {
        type: "UTTERANCE_DISCARDED",
        ...(context.utteranceId === undefined ? {} : { utteranceId: context.utteranceId }),
        reason: "FALSE_START"
      }));
      context.buffer.clear();
      context.utteranceId = undefined;
      context.utteranceStartTimestampMs = undefined;
      return events;
    }

    if (step.speechStarted && context.utteranceId !== undefined) {
      events.push(this.event(frame.envelope.requestId, frame.envelope.streamId, {
        type: "SPEECH_STARTED",
        utteranceId: context.utteranceId,
        atTimestampMs: context.utteranceStartTimestampMs ?? frame.envelope.timestampMs
      }));
    }
    if (step.possibleEndpoint && context.utteranceId !== undefined) {
      events.push(this.event(frame.envelope.requestId, frame.envelope.streamId, {
        type: "POSSIBLE_ENDPOINT",
        utteranceId: context.utteranceId,
        silenceMs: step.silenceMs
      }));
    }

    const decision = this.endpointDecision(context, {
      ...(heuristics.appearsIncomplete === undefined ? {} : { appearsIncomplete: heuristics.appearsIncomplete })
    });
    if (decision.kind === "DISCARD") {
      events.push(this.event(frame.envelope.requestId, frame.envelope.streamId, {
        type: "UTTERANCE_DISCARDED",
        ...(context.utteranceId === undefined ? {} : { utteranceId: context.utteranceId }),
        reason: decision.reason
      }));
      this.abandonStream(context);
    } else if (decision.kind === "FINALIZE") {
      context.finalizationStarted = true;
      events.push(...await this.finalizeAndRecognize(context, frame.envelope.requestId, decision.reason));
    }

    return this.shouldSuppressLateResult(context) ? [] : events;
  }

  private async finalizeAndRecognize(
    context: StreamContext,
    requestId: RequestId,
    reason: "SILENCE" | "MAX_DURATION" | "FLUSH"
  ): Promise<SpeechWorkerEvent[]> {
    const utteranceId = context.utteranceId;
    if (utteranceId === undefined || context.buffer.getSampleCount() === 0) {
      this.abandonStream(context);
      return [this.event(requestId, context.streamId, {
        type: "UTTERANCE_DISCARDED",
        reason: "TOO_SHORT"
      })];
    }

    let basis;
    let pcmBytes;
    let durationMs;
    let speechFrameCount;
    try {
      context.vad.finalize();
      basis = context.buffer.sourceBasis(context.streamId);
      durationMs = context.buffer.getDurationMs();
      speechFrameCount = context.buffer.getSpeechFrameCount();
      pcmBytes = context.buffer.materialize();
      context.buffer.clear();
    } catch {
      this.abandonStream(context);
      throw new SpeechWorkerCoreError("INTERNAL_ERROR", "Speech worker could not finalize the bounded audio basis");
    }

    if (sha256(pcmBytes) !== basis.pcmSha256) {
      this.abandonStream(context);
      throw new SpeechWorkerCoreError("INTERNAL_ERROR", "Finalized PCM did not match its audio basis");
    }

    const events: SpeechWorkerEvent[] = [this.event(requestId, context.streamId, {
      type: "UTTERANCE_FINALIZED",
      utteranceId,
      finalizationReason: reason,
      speechFrameCount,
      durationMs,
      sourceAudioBasis: basis
    })];

    context.recognizing = true;
    context.recognitionRequestId = requestId;
    const abortController = new AbortController();
    context.recognitionAbort = abortController;
    try {
      const recognizerBasis = SourceAudioBasisSchema.parse(basis);
      const raw = await withTimeout(
        Promise.resolve().then(async () => this.options.recognizer.recognize({
          requestId,
          utteranceId,
          pcmBytes,
          sourceAudioBasis: recognizerBasis
        }, abortController.signal)),
        this.recognizerTimeoutMs,
        () => abortController.abort()
      );
      if (context.cancelled || context.terminal || abortController.signal.aborted || this.shuttingDown) return [];
      if (sha256(pcmBytes) !== basis.pcmSha256) {
        events.push(this.errorEvent(
          requestId,
          context.streamId,
          "RECOGNIZER_PROTOCOL_ERROR",
          "Recognizer mutated bounded PCM input"
        ));
        this.rememberDiagnostic({ code: "RECOGNIZER_PROTOCOL_ERROR", streamId: context.streamId });
        return events;
      }
      try {
        const { candidate } = this.transcriptGate.admit(raw, {
          requestId,
          utteranceId,
          sourceAudioBasis: basis,
          modelIdentity: this.recognizerModelIdentity
        });
        events.push(this.event(requestId, context.streamId, {
          type: "TRANSCRIPT_CANDIDATE",
          candidate
        }));
      } catch {
        events.push(this.errorEvent(
          requestId,
          context.streamId,
          "RECOGNIZER_PROTOCOL_ERROR",
          "Recognizer returned an invalid bounded result"
        ));
      }
    } catch (error) {
      if (context.cancelled || context.terminal || this.shuttingDown) return [];
      if (error instanceof OperationTimeoutError) {
        events.push(this.errorEvent(requestId, context.streamId, "RECOGNIZER_TIMEOUT", "Recognizer timed out"));
        this.rememberDiagnostic({ code: "RECOGNIZER_TIMEOUT", streamId: context.streamId });
      } else {
        events.push(this.errorEvent(
          requestId,
          context.streamId,
          "RECOGNIZER_FAILURE",
          "Recognizer failed to produce a result"
        ));
        this.rememberDiagnostic({ code: "RECOGNIZER_FAILURE", streamId: context.streamId });
      }
    } finally {
      context.recognizing = false;
      context.recognitionAbort = undefined;
      context.recognitionRequestId = undefined;
      context.buffer.clear();
      context.terminal = true;
      this.streams.delete(context.streamId);
      this.rememberClosedStream(context.streamId);
    }
    return this.shouldSuppressLateResult(context) ? [] : events;
  }

  private endpointDecision(
    context: StreamContext,
    options: {
      readonly explicitFlush?: boolean;
      readonly forceMaximumDuration?: boolean;
      readonly appearsIncomplete?: boolean;
    }
  ): EndpointingDecision {
    try {
      const snapshot = context.vad.snapshot();
      return context.endpointing.decide({
        ...snapshot,
        ...(options.forceMaximumDuration === true
          ? { utteranceMs: context.endpointing.getMaximumUtteranceMs() }
          : {}),
        ...(options.explicitFlush === undefined ? {} : { explicitFlush: options.explicitFlush }),
        ...(options.appearsIncomplete === undefined ? {} : { appearsIncomplete: options.appearsIncomplete })
      });
    } catch {
      this.abandonStream(context);
      throw new SpeechWorkerCoreError("INTERNAL_ERROR", "Endpointing policy failed");
    }
  }

  private wouldExceedEndpointMaximum(context: StreamContext, nextFrameDurationMs: number): boolean {
    try {
      const snapshot = context.vad.snapshot();
      return context.utteranceId !== undefined
        && context.buffer.getSampleCount() > 0
        && snapshot.utteranceMs + nextFrameDurationMs > context.endpointing.getMaximumUtteranceMs() + 0.001;
    } catch {
      this.abandonStream(context);
      throw new SpeechWorkerCoreError("INTERNAL_ERROR", "Speech endpoint state could not be inspected");
    }
  }

  private async serialize<T>(context: StreamContext, operation: () => Promise<T>): Promise<T> {
    const prior = context.processingTail;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    context.processingTail = prior.then(() => current, () => current);
    try {
      await prior.catch(() => undefined);
      return await operation();
    } finally {
      release?.();
    }
  }

  private getOrCreateStream(streamId: SpeechStreamId): StreamContext {
    const existing = this.streams.get(streamId);
    if (existing !== undefined) return existing;
    if (this.closedStreams.has(streamId)) {
      throw new SpeechWorkerCoreError("STREAM_FINALIZED", "Speech stream has already finalized");
    }
    if (this.streams.size >= this.maxConcurrentStreams) {
      throw new SpeechWorkerCoreError("RESOURCE_LIMIT", "Maximum concurrent speech streams reached");
    }
    let context: StreamContext;
    try {
      context = {
        streamId,
        vad: this.options.vadStateFactory?.() ?? new VoiceActivityStateMachine(),
        endpointing: this.options.endpointingFactory?.() ?? new AdaptiveEndpointingPolicy(),
        buffer: new BoundedPcmBuffer(this.maxBufferedPcmBytes),
        processingTail: Promise.resolve(),
        order: undefined,
        utteranceId: undefined,
        utteranceStartTimestampMs: undefined,
        preSpeechElapsedMs: 0,
        speechConfirmed: false,
        terminal: false,
        cancelled: false,
        finalizationStarted: false,
        recognizing: false,
        vadAbort: undefined,
        recognitionAbort: undefined,
        recognitionRequestId: undefined
      };
    } catch {
      throw new SpeechWorkerCoreError("INTERNAL_ERROR", "Speech stream configuration could not be initialized");
    }
    this.streams.set(streamId, context);
    return context;
  }

  private abandonStream(context: StreamContext): void {
    context.terminal = true;
    context.buffer.clear();
    this.streams.delete(context.streamId);
    this.rememberClosedStream(context.streamId);
  }

  private rememberClosedStream(streamId: SpeechStreamId): void {
    this.closedStreams.add(streamId);
    while (this.closedStreams.size > 1_024) {
      const oldest = this.closedStreams.values().next().value;
      if (oldest === undefined) break;
      this.closedStreams.delete(oldest);
    }
  }

  private createUtteranceId(): UtteranceId {
    return SpeechUtteranceIdSchema.parse(this.options.utteranceIdFactory?.() ?? newUtteranceId());
  }

  private runIdempotent(
    requestId: RequestId,
    fingerprint: string,
    operation: () => Promise<readonly SpeechWorkerEvent[]>,
    cancellationReserveStreamId?: SpeechStreamId
  ): Promise<readonly SpeechWorkerEvent[]> {
    const replay = this.replayMessage(requestId, fingerprint);
    if (replay !== undefined) return Promise.resolve(replay);

    const active = this.inFlightMessages.get(requestId);
    if (active !== undefined) {
      if (active.fingerprint !== fingerprint) {
        return Promise.reject(new SpeechWorkerCoreError(
          "REQUEST_ID_CONFLICT",
          "RequestId was reused concurrently with different speech content"
        ));
      }
      return active.promise.then((events) => cloneEvents(events));
    }

    let claimedCancellationReserve = false;
    if (this.inFlightMessages.size >= this.maxInFlightRequests) {
      const canUseReserve = cancellationReserveStreamId !== undefined
        && !this.cancellationReserveClaims.has(cancellationReserveStreamId)
        && this.inFlightMessages.size < this.maxInFlightRequests + this.maxConcurrentStreams;
      if (!canUseReserve) {
        return Promise.reject(new SpeechWorkerCoreError(
          "RESOURCE_LIMIT",
          "Maximum in-flight speech request count reached"
        ));
      }
      this.cancellationReserveClaims.add(cancellationReserveStreamId);
      claimedCancellationReserve = true;
    }

    const token = {};
    const canonical = Promise.resolve()
      .then(operation)
      .then((events) => {
        const cloned = cloneEvents(events);
        this.rememberEvents(requestId, fingerprint, cloned);
        return cloned;
      })
      .catch((error: unknown) => {
        const normalized = normalizeWorkerError(error);
        this.rememberError(requestId, fingerprint, normalized);
        throw normalized;
      })
      .finally(() => {
        if (this.inFlightMessages.get(requestId)?.token === token) this.inFlightMessages.delete(requestId);
        if (claimedCancellationReserve && cancellationReserveStreamId !== undefined) {
          this.cancellationReserveClaims.delete(cancellationReserveStreamId);
        }
      });
    const tracked: InFlightMessage = { fingerprint, token, promise: canonical };
    this.inFlightMessages.set(requestId, tracked);
    return canonical.then((events) => cloneEvents(events));
  }

  private replayMessage(requestId: RequestId, fingerprint: string): readonly SpeechWorkerEvent[] | undefined {
    const remembered = this.messages.get(requestId);
    if (remembered === undefined) return undefined;
    if (remembered.fingerprint !== fingerprint) {
      throw new SpeechWorkerCoreError("REQUEST_ID_CONFLICT", "RequestId was reused with different speech content");
    }
    if (remembered.kind === "ERROR") {
      throw new SpeechWorkerCoreError(remembered.code, remembered.message);
    }
    return cloneEvents(remembered.events);
  }

  private rememberEvents(requestId: RequestId, fingerprint: string, events: readonly SpeechWorkerEvent[]): void {
    this.rememberOutcome(requestId, {
      fingerprint,
      kind: "EVENTS",
      events: cloneEvents(events)
    });
  }

  private rememberError(requestId: RequestId, fingerprint: string, error: SpeechWorkerCoreError): void {
    this.rememberOutcome(requestId, {
      fingerprint,
      kind: "ERROR",
      code: error.code,
      message: error.message
    });
  }

  private rememberOutcome(requestId: RequestId, outcome: RememberedMessage): void {
    this.messages.set(requestId, outcome);
    if (this.messages.size <= this.maxRememberedMessages) return;
    const oldest = this.messages.keys().next().value;
    if (oldest !== undefined) this.messages.delete(oldest);
  }

  private async attemptRecognizerCancel(requestId: RequestId, streamId: SpeechStreamId): Promise<boolean> {
    const recognizer = this.options.recognizer;
    if (recognizer.cancel === undefined) return false;
    try {
      const result = await withTimeout(
        Promise.resolve().then(async () => recognizer.cancel?.(requestId) ?? false),
        this.cancellationTimeoutMs,
        () => undefined
      );
      return result === true;
    } catch (error) {
      this.rememberDiagnostic({
        code: error instanceof OperationTimeoutError ? "CANCELLATION_TIMEOUT" : "CANCELLATION_FAILURE",
        streamId
      });
      return false;
    }
  }

  private shouldSuppressLateResult(context: StreamContext): boolean {
    return context.cancelled || this.shuttingDown;
  }

  private event(
    requestId: RequestId,
    streamId: SpeechStreamId,
    payload: Readonly<Record<string, unknown>>
  ): SpeechWorkerEvent {
    return SpeechWorkerEventSchema.parse({
      protocolVersion: 1,
      requestId,
      streamId,
      ...payload
    });
  }

  private errorEvent(
    requestId: RequestId,
    streamId: SpeechStreamId,
    code: SpeechWorkerErrorCode,
    message: string
  ): SpeechWorkerEvent {
    return this.event(requestId, streamId, { type: "SPEECH_WORKER_ERROR", code, message });
  }

  private rememberDiagnostic(input: SpeechWorkerDiagnostic): void {
    const diagnostic: SpeechWorkerDiagnostic = {
      code: input.code.slice(0, MAX_SPEECH_DIAGNOSTIC_CHARS),
      ...(input.streamId === undefined ? {} : { streamId: input.streamId }),
      ...(input.detail === undefined ? {} : { detail: input.detail.slice(0, MAX_SPEECH_DIAGNOSTIC_CHARS) })
    };
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > MAX_SPEECH_DIAGNOSTICS) this.diagnostics.shift();
  }
}

class OperationTimeoutError extends Error {}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {
        // Timeout cleanup is best-effort and may not undermine suppression.
      }
      reject(new OperationTimeoutError("Speech worker operation timed out"));
    }, timeoutMs);

    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Speech worker operation failed"));
      }
    );
  });
}

function safeCancelVad(vad: VoiceActivityStateMachine): void {
  try {
    vad.cancel();
  } catch {
    // State is already terminal; the stream tombstone remains authoritative locally.
  }
}

function cloneEvents(events: readonly SpeechWorkerEvent[]): SpeechWorkerEvent[] {
  return events.map((event) => SpeechWorkerEventSchema.parse(event));
}

function translatePcmError(error: unknown): SpeechWorkerCoreError {
  if (error instanceof PcmAdmissionError) return new SpeechWorkerCoreError(error.code, error.message);
  return new SpeechWorkerCoreError("INVALID_FRAME", "PCM frame admission failed");
}

function normalizeWorkerError(error: unknown): SpeechWorkerCoreError {
  return error instanceof SpeechWorkerCoreError
    ? new SpeechWorkerCoreError(error.code, error.message)
    : new SpeechWorkerCoreError("INTERNAL_ERROR", "Speech worker operation failed");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fingerprintParts(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function boundedPositiveSafeInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer no greater than ${String(maximum)}`);
  }
  return value;
}
