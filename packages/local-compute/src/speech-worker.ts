import { createHash } from "node:crypto";
import {
  newUtteranceId,
  type RequestId,
  type UtteranceId
} from "../../domain/src/index.js";
import {
  MAX_SPEECH_BUFFERED_PCM_BYTES,
  MAX_SPEECH_CONCURRENT_STREAMS,
  MAX_SPEECH_DIAGNOSTIC_CHARS,
  MAX_SPEECH_DIAGNOSTICS,
  SpeechCancelRequestSchema,
  SpeechFlushRequestSchema,
  SpeechWorkerEventSchema,
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
  type VadBackend
} from "./speech-vad.js";
import {
  TranscriptResultGate,
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
  cancelled: boolean;
  finalizationStarted: boolean;
  recognizing: boolean;
  recognitionAbort: AbortController | undefined;
  recognitionRequestId: RequestId | undefined;
}

interface RememberedMessage {
  readonly fingerprint: string;
  readonly events: readonly SpeechWorkerEvent[];
}

export interface SpeechWorkerCoreOptions {
  readonly vadBackend: VadBackend;
  readonly recognizer: SpeechRecognizer;
  readonly maxConcurrentStreams?: number;
  readonly maxBufferedPcmBytes?: number;
  readonly maxRememberedMessages?: number;
  readonly utteranceIdFactory?: () => UtteranceId;
  readonly endpointingFactory?: () => AdaptiveEndpointingPolicy;
  readonly vadStateFactory?: () => VoiceActivityStateMachine;
}

export interface SpeechFrameHeuristics {
  readonly appearsIncomplete?: boolean;
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
  private readonly diagnostics: SpeechWorkerDiagnostic[] = [];
  private readonly transcriptGate = new TranscriptResultGate();
  private readonly maxConcurrentStreams: number;
  private readonly maxBufferedPcmBytes: number;
  private readonly maxRememberedMessages: number;
  private shuttingDown = false;

  public constructor(private readonly options: SpeechWorkerCoreOptions) {
    this.maxConcurrentStreams = positiveSafeInteger(options.maxConcurrentStreams ?? MAX_SPEECH_CONCURRENT_STREAMS, "maxConcurrentStreams");
    this.maxBufferedPcmBytes = positiveSafeInteger(options.maxBufferedPcmBytes ?? MAX_SPEECH_BUFFERED_PCM_BYTES, "maxBufferedPcmBytes");
    this.maxRememberedMessages = positiveSafeInteger(options.maxRememberedMessages ?? 1_024, "maxRememberedMessages");
  }

  public getDiagnostics(): readonly SpeechWorkerDiagnostic[] {
    return this.diagnostics.map((item) => ({ ...item }));
  }

  public getActiveStreamCount(): number {
    return this.streams.size;
  }

  public async submitFrame(
    envelopeInput: unknown,
    payload: ArrayBufferView,
    heuristics: SpeechFrameHeuristics = {}
  ): Promise<readonly SpeechWorkerEvent[]> {
    if (this.shuttingDown) throw new SpeechWorkerCoreError("SHUTTING_DOWN", "Speech worker is shutting down");

    let frame: PcmFrameSnapshot;
    try {
      frame = snapshotPcmFrame(envelopeInput, payload);
    } catch (error) {
      throw translatePcmError(error);
    }
    const fingerprint = fingerprintParts(JSON.stringify(frame.envelope), frame.fingerprint, JSON.stringify(heuristics));
    const replay = this.replayMessage(frame.envelope.requestId, fingerprint);
    if (replay !== undefined) return replay;
    if (this.closedStreams.has(frame.envelope.streamId)) {
      throw new SpeechWorkerCoreError("STREAM_FINALIZED", "Speech stream has already finalized");
    }

    const context = this.getOrCreateStream(frame.envelope.streamId);
    return this.serialize(context, async () => {
      const replayInside = this.replayMessage(frame.envelope.requestId, fingerprint);
      if (replayInside !== undefined) return replayInside;
      if (context.cancelled || this.closedStreams.has(context.streamId)) {
        throw new SpeechWorkerCoreError("STREAM_FINALIZED", "Speech stream is no longer active");
      }
      if (context.finalizationStarted) {
        throw new SpeechWorkerCoreError("STREAM_FINALIZED", "Speech stream finalization has already started");
      }
      return this.processFrame(context, frame, heuristics, fingerprint);
    });
  }

  public async flush(input: unknown): Promise<readonly SpeechWorkerEvent[]> {
    if (this.shuttingDown) throw new SpeechWorkerCoreError("SHUTTING_DOWN", "Speech worker is shutting down");
    const parsed = SpeechFlushRequestSchema.safeParse(input);
    if (!parsed.success) throw new SpeechWorkerCoreError("INVALID_REQUEST", "Speech flush request is invalid");
    const request = parsed.data;
    const fingerprint = fingerprintParts(JSON.stringify(request));
    const replay = this.replayMessage(request.requestId, fingerprint);
    if (replay !== undefined) return replay;
    const context = this.streams.get(request.streamId);
    if (context === undefined) throw new SpeechWorkerCoreError("STREAM_NOT_FOUND", "Speech stream does not exist");

    return this.serialize(context, async () => {
      const replayInside = this.replayMessage(request.requestId, fingerprint);
      if (replayInside !== undefined) return replayInside;
      if (context.cancelled || context.finalizationStarted) {
        throw new SpeechWorkerCoreError("STREAM_FINALIZED", "Speech stream is no longer active");
      }

      const decision = context.endpointing.decide({ ...context.vad.snapshot(), explicitFlush: true });
      let events: SpeechWorkerEvent[] = [];
      if (decision.kind === "DISCARD") {
        events = [this.event(request.requestId, request.streamId, {
          type: "UTTERANCE_DISCARDED",
          ...(context.utteranceId === undefined ? {} : { utteranceId: context.utteranceId }),
          reason: decision.reason
        })];
        this.closeStream(request.streamId);
      } else if (decision.kind === "FINALIZE") {
        context.finalizationStarted = true;
        events = await this.finalizeAndRecognize(context, request.requestId, decision.reason);
      }
      this.rememberMessage(request.requestId, fingerprint, events);
      return cloneEvents(events);
    });
  }

  public async cancel(input: unknown): Promise<readonly SpeechWorkerEvent[]> {
    const parsed = SpeechCancelRequestSchema.safeParse(input);
    if (!parsed.success) throw new SpeechWorkerCoreError("INVALID_REQUEST", "Speech cancellation request is invalid");
    const request = parsed.data;
    const fingerprint = fingerprintParts(JSON.stringify(request));
    const replay = this.replayMessage(request.requestId, fingerprint);
    if (replay !== undefined) return replay;

    const context = this.streams.get(request.streamId);
    let cancellation: "RUNTIME_ABORT_REQUESTED" | "SUPPRESS_LATE_RESULT_ONLY" | "NOT_RECOGNIZING" = "NOT_RECOGNIZING";
    if (context !== undefined) {
      context.cancelled = true;
      context.recognitionAbort?.abort();
      context.buffer.clear();
      if (context.recognizing) {
        cancellation = "SUPPRESS_LATE_RESULT_ONLY";
        if (this.options.recognizer.cancellationCapability === "RUNTIME_ABORT" && this.options.recognizer.cancel !== undefined) {
          const recognitionRequestId = context.recognitionRequestId;
          const requested = recognitionRequestId === undefined ? false : await this.options.recognizer.cancel(recognitionRequestId);
          if (requested) cancellation = "RUNTIME_ABORT_REQUESTED";
        }
      } else {
        context.vad.cancel();
      }
      this.closeStream(request.streamId);
    }

    const events = [this.event(request.requestId, request.streamId, {
      type: "SPEECH_CANCELLED",
      cancellation
    })];
    this.rememberMessage(request.requestId, fingerprint, events);
    return cloneEvents(events);
  }

  public async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const cancellations: Promise<unknown>[] = [];
    for (const context of this.streams.values()) {
      context.cancelled = true;
      context.recognitionAbort?.abort();
      context.buffer.clear();
      if (!context.recognizing) context.vad.cancel();
      if (context.recognizing
          && context.recognitionRequestId !== undefined
          && this.options.recognizer.cancellationCapability === "RUNTIME_ABORT"
          && this.options.recognizer.cancel !== undefined) {
        cancellations.push(this.options.recognizer.cancel(context.recognitionRequestId));
      }
      this.closedStreams.add(context.streamId);
    }
    this.streams.clear();
    await Promise.allSettled(cancellations);
    this.rememberDiagnostic({ code: "SHUTDOWN" });
  }

  private async processFrame(
    context: StreamContext,
    frame: PcmFrameSnapshot,
    heuristics: SpeechFrameHeuristics,
    fingerprint: string
  ): Promise<readonly SpeechWorkerEvent[]> {
    try {
      context.order = advancePcmOrder(context.order, frame);
    } catch (error) {
      throw translatePcmError(error);
    }

    const stateBefore = context.vad.snapshot().state;
    const observation = await this.options.vadBackend.classify(frame);
    if (context.cancelled || this.shuttingDown) return [];

    let step;
    try {
      step = context.vad.step(observation.speechProbability, frame.durationMs);
    } catch {
      throw new SpeechWorkerCoreError("INVALID_FRAME", "VAD backend returned an invalid observation");
    }

    if (context.utteranceId === undefined && (step.state === "POSSIBLE_SPEECH" || step.speechStarted)) {
      context.utteranceId = this.createUtteranceId();
    }

    const shouldBuffer = stateBefore !== "SILENCE" || step.state !== "SILENCE";
    if (shouldBuffer && !step.falseStart) {
      try {
        context.buffer.append(frame, step.speechClassified);
      } catch (error) {
        throw translatePcmError(error);
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
      this.rememberMessage(frame.envelope.requestId, fingerprint, events);
      return cloneEvents(events);
    }

    if (step.speechStarted && context.utteranceId !== undefined) {
      events.push(this.event(frame.envelope.requestId, frame.envelope.streamId, {
        type: "SPEECH_STARTED",
        utteranceId: context.utteranceId,
        atTimestampMs: frame.envelope.timestampMs
      }));
    }
    if (step.possibleEndpoint && context.utteranceId !== undefined) {
      events.push(this.event(frame.envelope.requestId, frame.envelope.streamId, {
        type: "POSSIBLE_ENDPOINT",
        utteranceId: context.utteranceId,
        silenceMs: step.silenceMs
      }));
    }

    const decision = context.endpointing.decide({
      ...context.vad.snapshot(),
      ...(heuristics.appearsIncomplete === undefined ? {} : { appearsIncomplete: heuristics.appearsIncomplete })
    });
    if (decision.kind === "DISCARD") {
      events.push(this.event(frame.envelope.requestId, frame.envelope.streamId, {
        type: "UTTERANCE_DISCARDED",
        ...(context.utteranceId === undefined ? {} : { utteranceId: context.utteranceId }),
        reason: decision.reason
      }));
      this.closeStream(context.streamId);
    } else if (decision.kind === "FINALIZE") {
      context.finalizationStarted = true;
      events.push(...await this.finalizeAndRecognize(context, frame.envelope.requestId, decision.reason));
    }

    this.rememberMessage(frame.envelope.requestId, fingerprint, events);
    return cloneEvents(events);
  }

  private async finalizeAndRecognize(
    context: StreamContext,
    requestId: RequestId,
    reason: "SILENCE" | "MAX_DURATION" | "FLUSH"
  ): Promise<SpeechWorkerEvent[]> {
    const utteranceId = context.utteranceId;
    if (utteranceId === undefined || context.buffer.getSampleCount() === 0) {
      this.closeStream(context.streamId);
      return [this.event(requestId, context.streamId, {
        type: "UTTERANCE_DISCARDED",
        reason: "TOO_SHORT"
      })];
    }

    context.vad.finalize();
    const basis = context.buffer.sourceBasis(context.streamId);
    const pcmBytes = context.buffer.materialize();
    const durationMs = basis.endTimestampMs - basis.startTimestampMs;
    const events: SpeechWorkerEvent[] = [this.event(requestId, context.streamId, {
      type: "UTTERANCE_FINALIZED",
      utteranceId,
      finalizationReason: reason,
      speechFrameCount: context.buffer.getSpeechFrameCount(),
      durationMs,
      sourceAudioBasis: basis
    })];

    context.recognizing = true;
    context.recognitionRequestId = requestId;
    const abortController = new AbortController();
    context.recognitionAbort = abortController;
    try {
      const raw = await this.options.recognizer.recognize({
        requestId,
        utteranceId,
        pcmBytes,
        sourceAudioBasis: basis
      }, abortController.signal);
      if (context.cancelled || abortController.signal.aborted || this.shuttingDown) return events;
      try {
        const { candidate } = this.transcriptGate.admit(raw, {
          requestId,
          utteranceId,
          sourceAudioBasis: basis
        });
        events.push(this.event(requestId, context.streamId, {
          type: "TRANSCRIPT_CANDIDATE",
          candidate
        }));
      } catch {
        events.push(this.errorEvent(requestId, context.streamId, "RECOGNIZER_PROTOCOL_ERROR", "Recognizer returned an invalid bounded result"));
      }
    } catch (error) {
      if (!context.cancelled && !abortController.signal.aborted && !this.shuttingDown) {
        events.push(this.errorEvent(requestId, context.streamId, "RECOGNIZER_FAILURE", "Recognizer failed to produce a result"));
        this.rememberDiagnostic({ code: "RECOGNIZER_FAILURE", streamId: context.streamId });
      }
      void error;
    } finally {
      context.recognizing = false;
      context.recognitionAbort = undefined;
      context.recognitionRequestId = undefined;
      context.buffer.clear();
      this.closeStream(context.streamId);
    }
    return events;
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
    if (this.streams.size >= this.maxConcurrentStreams) {
      throw new SpeechWorkerCoreError("RESOURCE_LIMIT", "Maximum concurrent speech streams reached");
    }
    const context: StreamContext = {
      streamId,
      vad: this.options.vadStateFactory?.() ?? new VoiceActivityStateMachine(),
      endpointing: this.options.endpointingFactory?.() ?? new AdaptiveEndpointingPolicy(),
      buffer: new BoundedPcmBuffer(this.maxBufferedPcmBytes),
      processingTail: Promise.resolve(),
      order: undefined,
      utteranceId: undefined,
      cancelled: false,
      finalizationStarted: false,
      recognizing: false,
      recognitionAbort: undefined,
      recognitionRequestId: undefined
    };
    this.streams.set(streamId, context);
    return context;
  }

  private closeStream(streamId: SpeechStreamId): void {
    this.streams.delete(streamId);
    this.closedStreams.add(streamId);
    while (this.closedStreams.size > 1_024) {
      const oldest = this.closedStreams.values().next().value;
      if (oldest === undefined) break;
      this.closedStreams.delete(oldest);
    }
  }

  private createUtteranceId(): UtteranceId {
    return this.options.utteranceIdFactory?.() ?? newUtteranceId();
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

  private replayMessage(requestId: RequestId, fingerprint: string): readonly SpeechWorkerEvent[] | undefined {
    const remembered = this.messages.get(requestId);
    if (remembered === undefined) return undefined;
    if (remembered.fingerprint !== fingerprint) {
      throw new SpeechWorkerCoreError("REQUEST_ID_CONFLICT", "RequestId was reused with different speech content");
    }
    return cloneEvents(remembered.events);
  }

  private rememberMessage(requestId: RequestId, fingerprint: string, events: readonly SpeechWorkerEvent[]): void {
    this.messages.set(requestId, { fingerprint, events: cloneEvents(events) });
    if (this.messages.size <= this.maxRememberedMessages) return;
    const oldest = this.messages.keys().next().value;
    if (oldest !== undefined) this.messages.delete(oldest);
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

function cloneEvents(events: readonly SpeechWorkerEvent[]): SpeechWorkerEvent[] {
  return events.map((event) => SpeechWorkerEventSchema.parse(event));
}

function translatePcmError(error: unknown): SpeechWorkerCoreError {
  if (error instanceof PcmAdmissionError) return new SpeechWorkerCoreError(error.code, error.message);
  return new SpeechWorkerCoreError("INVALID_FRAME", "PCM frame admission failed");
}

function fingerprintParts(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}
