import { createHash } from "node:crypto";
import {
  DeliveryIdSchema,
  GenerationIdSchema,
  SessionIdSchema,
  newRequestId,
  type DeliveryAtom,
  type DeliveryId,
  type GenerationId,
  type InputEpisodeId,
  type SessionId,
  type TurnId,
  type UtteranceId
} from "../../../packages/domain/src/index.js";
import {
  MAX_SPEECH_CONCURRENT_STREAMS,
  SourceAudioBasisSchema,
  SpeechPcmFrameEnvelopeSchema,
  SpeechStreamIdSchema,
  TTS_LIMITS,
  TtsModelIdentitySchema,
  TtsOutgoingMessageSchema,
  TtsSampleRateSchema,
  TtsSynthesizeRequestSchema,
  planTtsRequest,
  type SourceAudioBasis,
  type SpeechPcmFrameEnvelope,
  type SpeechSampleRate,
  type SpeechStreamId,
  type SpeechWorkerCore,
  type SpeechWorkerEvent,
  type TtsLanguage,
  type TtsModelIdentity,
  type TtsOutgoingMessage,
  type TtsSampleRate,
  type TtsWorkerCore
} from "../../../packages/local-compute/src/index.js";
import {
  TurnCoordinator
} from "../../../packages/interview-engine/src/index.js";
import type { SessionState } from "../../../packages/events/src/index.js";
import type { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";
import type { ServerTurnOrchestrator } from "./turn-orchestrator.js";

const MAX_EPHEMERAL_AUDIO_ASSETS = 32;
const MAX_EPHEMERAL_AUDIO_BYTES = 32 * 1024 * 1024;
const VOICE_STREAM_IDLE_TIMEOUT_MS = 5_000;
const AUDIO_REF_PATTERN = /^audio_v1_[0-9a-f]{64}$/u;

export interface VoiceTtsRuntimeConfiguration {
  readonly worker: TtsWorkerCore;
  readonly voice: string;
  readonly language: TtsLanguage;
  readonly sampleRate: TtsSampleRate;
  readonly speed?: number;
}

export interface VoiceRuntimeConfiguration {
  readonly speechWorker: SpeechWorkerCore;
  readonly tts: VoiceTtsRuntimeConfiguration;
}

export interface EphemeralAudioAssetMetadata {
  readonly sessionId: SessionId;
  readonly generationId: GenerationId;
  readonly sourceDeliveryId: DeliveryId;
  readonly textSha256: string;
  readonly requestBasisHash: string;
  readonly normalizedTextHash: string;
  readonly audioSha256: string;
  readonly model: TtsModelIdentity;
  readonly sampleRate: TtsSampleRate;
  readonly durationMs: number;
}

interface StoredAudioAsset {
  readonly metadata: EphemeralAudioAssetMetadata;
  readonly bytes: Uint8Array;
}

export interface ResolvedEphemeralAudioAsset {
  readonly audioRef: string;
  readonly metadata: EphemeralAudioAssetMetadata;
  readonly bytes: Uint8Array;
}

/**
 * Process-local audio bytes are intentionally ephemeral. The durable event log
 * stores only the bounded logical audioRef. Missing assets therefore fail
 * closed on reconnect rather than turning filesystem paths or blobs into
 * authoritative state.
 */
export class EphemeralAudioAssetStore {
  private readonly assets = new Map<string, StoredAudioAsset>();
  private totalBytes = 0;

  public register(
    metadataInput: EphemeralAudioAssetMetadata,
    bytesInput: Uint8Array
  ): string {
    const metadata = snapshotAssetMetadata(metadataInput);
    if (
      !(bytesInput instanceof Uint8Array)
      || bytesInput.byteLength === 0
      || bytesInput.byteLength > TTS_LIMITS.maxPcmBytes + 64 * 1024
    ) {
      throw new Error("Ephemeral audio asset exceeds its bounded size");
    }
    const bytes = snapshotBytes(bytesInput);

    const audioRef = computeAudioRef(metadata);
    const existing = this.assets.get(audioRef);
    if (existing !== undefined) {
      if (!sameMetadata(existing.metadata, metadata) || !sameBytes(existing.bytes, bytes)) {
        throw new Error("Ephemeral audio reference collided with different content");
      }
      return audioRef;
    }
    if (this.assets.size >= MAX_EPHEMERAL_AUDIO_ASSETS) {
      throw new Error("Ephemeral audio asset count limit reached");
    }
    if (this.totalBytes + bytes.byteLength > MAX_EPHEMERAL_AUDIO_BYTES) {
      throw new Error("Ephemeral audio byte limit reached");
    }

    this.assets.set(audioRef, { metadata, bytes });
    this.totalBytes += bytes.byteLength;
    return audioRef;
  }

  public has(sessionIdInput: SessionId, audioRef: string): boolean {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    if (!isBoundedAudioRef(audioRef)) return false;
    return this.assets.get(audioRef)?.metadata.sessionId === sessionId;
  }

  /**
   * A successful fetch transfers byte ownership to the renderer's Blob URL.
   * The server copy is single-use and removed immediately to keep buffering
   * bounded. Delivery uncertainty remains authoritative in the delivery state,
   * not in this cache.
   */
  public take(sessionIdInput: SessionId, audioRef: string): ResolvedEphemeralAudioAsset | undefined {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    if (!isBoundedAudioRef(audioRef)) return undefined;
    const asset = this.assets.get(audioRef);
    if (asset === undefined || asset.metadata.sessionId !== sessionId) return undefined;
    this.assets.delete(audioRef);
    this.totalBytes = Math.max(0, this.totalBytes - asset.bytes.byteLength);
    return {
      audioRef,
      metadata: snapshotAssetMetadata(asset.metadata),
      bytes: snapshotBytes(asset.bytes)
    };
  }

  public remove(audioRef: string): void {
    if (!isBoundedAudioRef(audioRef)) return;
    const asset = this.assets.get(audioRef);
    if (asset === undefined) return;
    this.assets.delete(audioRef);
    this.totalBytes = Math.max(0, this.totalBytes - asset.bytes.byteLength);
  }

  public pruneUnauthorizedSessionAssets(sessionIdInput: SessionId, state: Readonly<SessionState>): void {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const authorizedRefs = new Set(
      Object.values(state.deliveries)
        .filter((atom) =>
          atom.content.medium === "AUDIO"
          && (atom.status === "QUEUED" || atom.status === "DELIVERING")
        )
        .map((atom) => atom.content.medium === "AUDIO" ? atom.content.audioRef : "")
    );
    for (const [audioRef, asset] of this.assets) {
      if (asset.metadata.sessionId === sessionId && !authorizedRefs.has(audioRef)) {
        this.remove(audioRef);
      }
    }
  }

  public clear(): void {
    this.assets.clear();
    this.totalBytes = 0;
  }

  public inspect(): { readonly count: number; readonly bytes: number } {
    return { count: this.assets.size, bytes: this.totalBytes };
  }
}

interface TtsAssembly {
  begin: Extract<TtsOutgoingMessage, { readonly type: "AUDIO_BEGIN" }> | undefined;
  chunks: Array<Extract<TtsOutgoingMessage, { readonly type: "AUDIO_CHUNK" }>>;
  end: Extract<TtsOutgoingMessage, { readonly type: "AUDIO_END" }> | undefined;
}

export class VoiceSynthesisCoordinator {
  private readonly activeBySession = new Map<SessionId, Set<string>>();
  private readonly inFlightSourceDeliveries = new Map<SessionId, Set<DeliveryId>>();

  public constructor(
    private readonly sessions: SessionRecoveryCoordinator,
    private readonly assets: EphemeralAudioAssetStore,
    private readonly config: VoiceTtsRuntimeConfiguration
  ) {
    if (!Number.isFinite(config.speed ?? 1) || (config.speed ?? 1) < 0.5 || (config.speed ?? 1) > 2) {
      throw new Error("Voice TTS speed is outside the supported range");
    }
  }

  public async synthesizeSentTextDelivery(
    sessionIdInput: SessionId,
    sourceDeliveryIdInput: DeliveryId
  ): Promise<DeliveryAtom | undefined> {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const sourceDeliveryId = DeliveryIdSchema.parse(sourceDeliveryIdInput);
    const inFlightForSession =
      this.inFlightSourceDeliveries.get(sessionId) ?? new Set<DeliveryId>();
    if (inFlightForSession.has(sourceDeliveryId)) return undefined;
    inFlightForSession.add(sourceDeliveryId);
    this.inFlightSourceDeliveries.set(sessionId, inFlightForSession);

    let registeredAudioRef: string | undefined;
    try {
      await this.sessions.ensureRecovered(sessionId);
      const writer = this.sessions.getWriter(sessionId);
      const initialState = writer.getState();
      const source = initialState.deliveries[sourceDeliveryId];
      if (
        source === undefined
        || source.content.medium !== "TEXT"
        || (
          source.status !== "DELIVERING"
          && source.status !== "EXPOSED"
          && source.status !== "COMPLETED"
        )
      ) {
        return undefined;
      }

      const generationId = GenerationIdSchema.parse(source.generationId);
      const exactText = source.content.text;
      const existingAudio = Object.values(initialState.deliveries).find((atom) =>
        atom.content.medium === "AUDIO"
        && atom.generationId === generationId
        && atom.content.text === exactText
        && atom.status !== "CANCELLED"
      );
      if (existingAudio !== undefined) return undefined;

      const textSha256 = sha256Utf8(exactText);
      const request = TtsSynthesizeRequestSchema.parse({
        protocolVersion: 1,
        type: "SYNTHESIZE",
        requestId: newRequestId(),
        text: exactText,
        voice: this.config.voice,
        speed: this.config.speed ?? 1,
        language: this.config.language,
        sampleRate: this.config.sampleRate,
        outputFormat: "PCM_F32LE"
      });
      const plan = planTtsRequest(request);
      const assembly: TtsAssembly = { begin: undefined, chunks: [], end: undefined };
      this.rememberActive(sessionId, request.requestId);

      try {
        const summary = await this.config.worker.handle(request, async (messageInput) => {
          const message = TtsOutgoingMessageSchema.parse(messageInput);
          if (message.requestId !== request.requestId) {
            throw new Error("TTS callback request identity changed");
          }
          if (message.type === "TTS_ERROR" || message.type === "CANCEL_RESULT") {
            throw new Error("TTS synthesis emitted an unexpected control result");
          }
          if (message.requestBasisHash !== plan.requestBasisHash) {
            throw new Error("TTS callback basis does not match the exact admitted text/configuration");
          }
          if (message.type === "AUDIO_BEGIN") {
            if (
              assembly.begin !== undefined
              || message.normalizedTextHash !== plan.normalizedTextHash
            ) {
              throw new Error("TTS begin metadata does not match the admitted synthesis");
            }
            assembly.begin = message;
            return;
          }
          if (message.type === "AUDIO_CHUNK") {
            if (assembly.begin === undefined || assembly.end !== undefined) {
              throw new Error("TTS chunk arrived outside the admitted audio stream");
            }
            if (message.sequence !== assembly.chunks.length + 1 || message.chunkIndex !== assembly.chunks.length) {
              throw new Error("TTS chunk sequence is discontinuous");
            }
            assembly.chunks.push(message);
            return;
          }
          if (assembly.begin === undefined || assembly.end !== undefined) {
            throw new Error("TTS end arrived outside the admitted audio stream");
          }
          if (message.sequence !== assembly.chunks.length + 1) {
            throw new Error("TTS end sequence is discontinuous");
          }
          assembly.end = message;
        });

        if (summary.kind !== "SYNTHESIS" || summary.summary.outcome !== "DONE") return undefined;
        const begin = assembly.begin;
        const end = assembly.end;
        if (begin === undefined || end === undefined || assembly.chunks.length === 0) {
          throw new Error("TTS completed without a complete bounded audio stream");
        }
        if (
          begin.model.engine !== end.model.engine
          || begin.model.modelId !== end.model.modelId
          || begin.model.modelVersion !== end.model.modelVersion
          || begin.model.runtimeVersion !== end.model.runtimeVersion
          || begin.model.waveformDeterminism !== end.model.waveformDeterminism
        ) {
          throw new Error("TTS model/runtime identity changed within one synthesis");
        }

        const pcm = concatenateTtsPcm(assembly.chunks, end.totalBytes);
        if (sha256Bytes(pcm) !== end.audioHash) {
          throw new Error("TTS aggregate audio hash does not match emitted PCM");
        }
        const wav = encodePcm16Wav(pcm, end.sampleRate);
        const metadata: EphemeralAudioAssetMetadata = {
          sessionId,
          generationId,
          sourceDeliveryId,
          textSha256,
          requestBasisHash: plan.requestBasisHash,
          normalizedTextHash: plan.normalizedTextHash,
          audioSha256: end.audioHash,
          model: { ...end.model },
          sampleRate: end.sampleRate,
          durationMs: end.durationMs
        };
        const audioRef = this.assets.register(metadata, wav);
        registeredAudioRef = audioRef;

        const audioAtom = await new TurnCoordinator(writer).queueAudioDeliveryFromValidatedText({
          sourceDeliveryId,
          generationId,
          text: exactText,
          textSha256,
          audioRef
        });
        if (audioAtom === undefined) {
          this.assets.remove(audioRef);
          registeredAudioRef = undefined;
          return undefined;
        }

        // Ownership of the ephemeral bytes now belongs to the authoritative
        // queued AUDIO delivery until the renderer resolves or invalidates it.
        registeredAudioRef = undefined;
        return audioAtom;
      } finally {
        this.forgetActive(sessionId, request.requestId);
      }
    } catch {
      if (registeredAudioRef !== undefined) this.assets.remove(registeredAudioRef);
      return undefined;
    } finally {
      const inFlightForSession = this.inFlightSourceDeliveries.get(sessionId);
      inFlightForSession?.delete(sourceDeliveryId);
      if (inFlightForSession?.size === 0) {
        this.inFlightSourceDeliveries.delete(sessionId);
      }
    }
  }

  public async cancelSession(sessionIdInput: SessionId): Promise<void> {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const requestIds = [...(this.activeBySession.get(sessionId) ?? [])];
    await Promise.all(requestIds.map(async (requestId) => {
      try {
        await this.config.worker.handle({
          protocolVersion: 1,
          type: "CANCEL_SYNTHESIS",
          requestId
        }, () => undefined);
      } catch {
        // Runtime cancellation is best-effort. Authoritative generation
        // invalidation still blocks late TTS admission.
      }
    }));
  }

  public async cancelAll(): Promise<void> {
    await Promise.all([...this.activeBySession.keys()].map(async (sessionId) =>
      this.cancelSession(sessionId)
    ));
  }

  public async shutdown(): Promise<void> {
    await this.config.worker.shutdown();
  }

  private rememberActive(sessionId: SessionId, requestId: string): void {
    const set = this.activeBySession.get(sessionId) ?? new Set<string>();
    set.add(requestId);
    this.activeBySession.set(sessionId, set);
  }

  private forgetActive(sessionId: SessionId, requestId: string): void {
    const set = this.activeBySession.get(sessionId);
    if (set === undefined) return;
    set.delete(requestId);
    if (set.size === 0) this.activeBySession.delete(sessionId);
  }
}

interface VoiceStreamContext {
  readonly sessionId: SessionId;
  readonly streamId: SpeechStreamId;
  readonly sampleRate: SpeechSampleRate;
  readonly token: object;
  expectedSequence: number;
  operationInFlight: boolean;
  active: boolean;
  authoritativeUtteranceId: UtteranceId | undefined;
  workerUtteranceId: UtteranceId | undefined;
  finalizedBasis: SourceAudioBasis | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface VoiceInputCommit {
  readonly inputEpisodeId: InputEpisodeId;
  readonly turnId: TurnId;
  readonly text: string;
}

export interface VoiceIngressResult {
  readonly events: readonly SpeechWorkerEvent[];
  readonly terminal: boolean;
  readonly commit?: VoiceInputCommit;
}

export class VoiceInputCoordinator {
  private readonly streams = new Map<SpeechStreamId, VoiceStreamContext>();
  private readonly sessionStreams = new Map<SessionId, SpeechStreamId>();

  public constructor(
    private readonly sessions: SessionRecoveryCoordinator,
    private readonly orchestrator: ServerTurnOrchestrator,
    private readonly speechWorker: SpeechWorkerCore,
    private readonly assets: EphemeralAudioAssetStore,
    private readonly synthesis: VoiceSynthesisCoordinator
  ) {}

  public async openStream(
    sessionIdInput: SessionId,
    streamIdInput: SpeechStreamId,
    sampleRate: SpeechSampleRate
  ): Promise<void> {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const streamId = SpeechStreamIdSchema.parse(streamIdInput);
    await this.sessions.ensureRecovered(sessionId);
    const state = this.sessions.getWriter(sessionId).getState();
    if (!state.started || state.status !== "ACTIVE") {
      throw new Error("Voice stream requires an active authoritative session");
    }

    const existing = this.streams.get(streamId);
    if (existing !== undefined) {
      if (
        existing.active
        && existing.sessionId === sessionId
        && existing.sampleRate === sampleRate
      ) {
        return;
      }
      throw new Error("Speech stream identity conflicts with an existing binding");
    }
    const existingForSession = this.sessionStreams.get(sessionId);
    if (existingForSession !== undefined) {
      throw new Error("Authoritative session already has an active speech stream");
    }
    if (this.streams.size >= MAX_SPEECH_CONCURRENT_STREAMS) {
      throw new Error("Speech stream concurrency limit reached");
    }

    const context: VoiceStreamContext = {
      sessionId,
      streamId,
      sampleRate,
      token: {},
      expectedSequence: 0,
      operationInFlight: false,
      active: true,
      authoritativeUtteranceId: undefined,
      workerUtteranceId: undefined,
      finalizedBasis: undefined,
      idleTimer: undefined
    };
    this.streams.set(streamId, context);
    this.sessionStreams.set(sessionId, streamId);
    this.refreshIdleLease(context);
  }

  public async submitFrame(
    sessionIdInput: SessionId,
    envelopeInput: SpeechPcmFrameEnvelope,
    payload: Uint8Array
  ): Promise<VoiceIngressResult> {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const envelope = SpeechPcmFrameEnvelopeSchema.parse(envelopeInput);
    const context = this.requireActiveStream(sessionId, envelope.streamId);
    if (context.sampleRate !== envelope.sampleRate) {
      throw new Error("PCM sample rate does not match the bound speech stream");
    }
    if (context.operationInFlight) {
      throw new Error("Only one PCM frame may be admitted per speech stream at a time");
    }
    if (envelope.sequence !== context.expectedSequence) {
      throw new Error("PCM sequence does not match the next admitted stream sequence");
    }

    context.operationInFlight = true;
    this.clearIdleLease(context);
    const token = context.token;
    try {
      const events = await this.speechWorker.submitFrame(envelope, payload);
      if (!this.isCurrent(context, token)) return { events: [], terminal: true };
      context.expectedSequence += 1;
      return await this.applyEvents(context, token, events);
    } finally {
      if (this.isCurrent(context, token)) {
        context.operationInFlight = false;
        this.refreshIdleLease(context);
      }
    }
  }

  public async flush(
    sessionIdInput: SessionId,
    streamIdInput: SpeechStreamId,
    requestId: string
  ): Promise<VoiceIngressResult> {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const streamId = SpeechStreamIdSchema.parse(streamIdInput);
    const context = this.requireActiveStream(sessionId, streamId);
    if (context.operationInFlight) {
      throw new Error("Speech stream already has an operation in flight");
    }
    context.operationInFlight = true;
    this.clearIdleLease(context);
    const token = context.token;
    try {
      const events = await this.speechWorker.flush({
        protocolVersion: 1,
        type: "FLUSH_SPEECH",
        requestId,
        streamId
      });
      if (!this.isCurrent(context, token)) return { events: [], terminal: true };
      return await this.applyEvents(context, token, events);
    } finally {
      if (this.isCurrent(context, token)) {
        context.operationInFlight = false;
        this.refreshIdleLease(context);
      }
    }
  }

  public async cancelStream(
    sessionIdInput: SessionId,
    streamIdInput: SpeechStreamId,
    requestId: string
  ): Promise<void> {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const streamId = SpeechStreamIdSchema.parse(streamIdInput);
    const context = this.streams.get(streamId);
    if (context === undefined || context.sessionId !== sessionId) return;
    context.active = false;
    this.releaseStreamBinding(context);

    try {
      await this.speechWorker.cancel({
        protocolVersion: 1,
        type: "CANCEL_SPEECH",
        requestId,
        streamId
      });
    } catch {
      // Suppression is already authoritative at this integration boundary.
    }

    await this.discardCapturingUtterance(context, "Speech stream cancelled");
  }

  public async cancelSession(sessionIdInput: SessionId): Promise<void> {
    const sessionId = SessionIdSchema.parse(sessionIdInput);
    const streamId = this.sessionStreams.get(sessionId);
    if (streamId === undefined) return;
    const context = this.streams.get(streamId);
    if (context === undefined || context.sessionId !== sessionId) {
      this.sessionStreams.delete(sessionId);
      return;
    }

    // Revoke application admission before awaiting fallible worker
    // cancellation. Any late worker callback fails the current-context checks.
    context.active = false;
    this.releaseStreamBinding(context);

    try {
      await this.speechWorker.cancel({
        protocolVersion: 1,
        type: "CANCEL_SPEECH",
        requestId: newRequestId(),
        streamId
      });
    } catch {
      // The authoritative integration binding is already revoked.
    }

    await this.discardCapturingUtterance(
      context,
      "Authoritative session became terminal"
    );
  }

  public async shutdown(): Promise<void> {
    const contexts = [...this.streams.values()];
    for (const context of contexts) {
      context.active = false;
      this.releaseStreamBinding(context);
      await this.discardCapturingUtterance(context, "Voice runtime shutdown");
    }
    await this.speechWorker.shutdown();
  }

  private async applyEvents(
    context: VoiceStreamContext,
    token: object,
    events: readonly SpeechWorkerEvent[]
  ): Promise<VoiceIngressResult> {
    let commit: VoiceInputCommit | undefined;
    let terminal = false;

    for (const event of events) {
      if (!this.isCurrent(context, token)) break;
      if (event.streamId !== context.streamId) {
        throw new Error("Speech worker callback escaped its bound stream");
      }

      if (event.type === "SPEECH_STARTED") {
        if (context.authoritativeUtteranceId !== undefined) {
          if (context.workerUtteranceId !== event.utteranceId) {
            throw new Error("Speech worker changed utterance identity after onset");
          }
          continue;
        }
        const writer = this.sessions.getWriter(context.sessionId);
        const current = writer.getState();
        if (!current.started || current.status !== "ACTIVE") {
          await this.terminateContext(context);
          terminal = true;
          break;
        }
        const authoritativeUtteranceId = await new TurnCoordinator(writer).beginUtterance();
        context.workerUtteranceId = event.utteranceId;
        context.authoritativeUtteranceId = authoritativeUtteranceId;
        if (!this.isCurrent(context, token)) {
          await this.discardCapturingUtterance(
            context,
            "Speech stream ceased before admitted onset could remain authoritative"
          );
          break;
        }

        // Authority changes before physical interruption/cancellation signals are
        // allowed to propagate. Provider/TTS cancellation may fail without
        // weakening the supersession state written by beginUtterance().
        void this.synthesis.cancelSession(context.sessionId).catch(() => undefined);
        this.assets.pruneUnauthorizedSessionAssets(context.sessionId, writer.getState());
        continue;
      }

      if (event.type === "UTTERANCE_DISCARDED") {
        if (
          event.utteranceId !== undefined
          && context.workerUtteranceId !== undefined
          && event.utteranceId !== context.workerUtteranceId
        ) {
          throw new Error("Speech discard refers to a different utterance");
        }
        await this.discardCapturingUtterance(context, `Speech worker discarded utterance: ${event.reason}`);
        terminal = true;
        await this.terminateContext(context);
        continue;
      }

      if (event.type === "UTTERANCE_FINALIZED") {
        this.assertBoundUtterance(context, event.utteranceId);
        const basis = SourceAudioBasisSchema.parse(event.sourceAudioBasis);
        if (
          basis.streamId !== context.streamId
          || basis.sampleRate !== context.sampleRate
          || basis.lastSequence >= context.expectedSequence
        ) {
          throw new Error("Finalized speech audio basis escaped its admitted stream frontier");
        }
        context.finalizedBasis = basis;
        continue;
      }

      if (event.type === "TRANSCRIPT_CANDIDATE") {
        const candidate = event.candidate;
        this.assertBoundUtterance(context, candidate.utteranceId);
        const finalizedBasis = context.finalizedBasis;
        if (
          finalizedBasis === undefined
          || !sameAudioBasis(finalizedBasis, candidate.sourceAudioBasis)
        ) {
          throw new Error("Transcript callback does not match the exact finalized SourceAudioBasis");
        }
        if (candidate.text.trim().length === 0) {
          await this.discardCapturingUtterance(context, "Speech recognizer returned an empty transcript");
          terminal = true;
          await this.terminateContext(context);
          continue;
        }

        const writer = this.sessions.getWriter(context.sessionId);
        const authoritativeId = context.authoritativeUtteranceId;
        if (authoritativeId === undefined) {
          throw new Error("Transcript arrived without an admitted authoritative utterance");
        }
        const turns = new TurnCoordinator(writer);

        // This is the frozen STT admission seam. Once finalization wins the
        // serialized authority transition, commit the resulting InputEpisode
        // immediately so cancellation cannot strand a finalized speech
        // episode. If cancellation serialized first, finalizeUtterance() fails
        // closed because the utterance is no longer CAPTURING.
        const finalized = await turns.finalizeUtterance({
          utteranceId: authoritativeId,
          text: candidate.text
        });
        const turnId = await turns.commitInputEpisode(finalized.inputEpisodeId);

        const turn = writer.getState().turns[turnId];
        if (
          turn === undefined
          || turn.inputEpisodeId !== finalized.inputEpisodeId
          || turn.studentText !== candidate.text
        ) {
          throw new Error("Committed voice turn does not match its admitted transcript");
        }
        commit = {
          inputEpisodeId: finalized.inputEpisodeId,
          turnId,
          text: candidate.text
        };
        void this.orchestrator.orchestrateTurn({
          sessionId: context.sessionId,
          turnId,
          inputEpisodeId: finalized.inputEpisodeId,
          studentText: candidate.text
        }).catch(() => {
          // The existing orchestrator owns safe provider failure handling.
        });
        terminal = true;
        await this.terminateContext(context);
        continue;
      }

      if (event.type === "SPEECH_WORKER_ERROR") {
        await this.discardCapturingUtterance(context, "Speech worker failed before a committed transcript");
        terminal = true;
        await this.terminateContext(context);
      }
    }

    return {
      events: [...events],
      terminal,
      ...(commit === undefined ? {} : { commit })
    };
  }

  private requireActiveStream(sessionId: SessionId, streamId: SpeechStreamId): VoiceStreamContext {
    const context = this.streams.get(streamId);
    if (context === undefined || !context.active || context.sessionId !== sessionId) {
      throw new Error("Speech stream is not bound to the current authoritative session");
    }
    return context;
  }

  private isCurrent(context: VoiceStreamContext, token: object): boolean {
    return context.active
      && context.token === token
      && this.streams.get(context.streamId) === context
      && this.sessionStreams.get(context.sessionId) === context.streamId;
  }

  private assertBoundUtterance(context: VoiceStreamContext, workerUtteranceId: UtteranceId): void {
    if (
      context.workerUtteranceId === undefined
      || context.authoritativeUtteranceId === undefined
      || context.workerUtteranceId !== workerUtteranceId
    ) {
      throw new Error("Speech callback does not match the admitted utterance identity");
    }
  }

  private async discardCapturingUtterance(context: VoiceStreamContext, reason: string): Promise<void> {
    const utteranceId = context.authoritativeUtteranceId;
    if (utteranceId === undefined || !this.sessions.hasSession(context.sessionId)) return;
    const writer = this.sessions.getWriter(context.sessionId);
    const utterance = writer.getState().utterances[utteranceId];
    if (utterance?.status !== "CAPTURING") return;
    try {
      await new TurnCoordinator(writer).discardUtterance(utteranceId, reason.slice(0, 512));
    } catch {
      // A concurrent authoritative terminal transition wins.
    }
  }

  private async terminateContext(context: VoiceStreamContext): Promise<void> {
    if (!context.active) return;
    context.active = false;
    this.releaseStreamBinding(context);
  }

  private clearIdleLease(context: VoiceStreamContext): void {
    if (context.idleTimer === undefined) return;
    clearTimeout(context.idleTimer);
    context.idleTimer = undefined;
  }

  private refreshIdleLease(context: VoiceStreamContext): void {
    this.clearIdleLease(context);
    const token = context.token;
    context.idleTimer = setTimeout(() => {
      void this.expireIdleStream(context, token);
    }, VOICE_STREAM_IDLE_TIMEOUT_MS);
  }

  private async expireIdleStream(context: VoiceStreamContext, token: object): Promise<void> {
    if (!this.isCurrent(context, token)) return;
    if (context.operationInFlight) {
      this.refreshIdleLease(context);
      return;
    }
    context.active = false;
    this.releaseStreamBinding(context);
    try {
      await this.speechWorker.cancel({
        protocolVersion: 1,
        type: "CANCEL_SPEECH",
        requestId: newRequestId(),
        streamId: context.streamId
      });
    } catch {
      // The local authority boundary below still discards any capturing
      // utterance even if worker cancellation is unavailable.
    }
    await this.discardCapturingUtterance(
      context,
      "Speech stream expired after bounded transport inactivity"
    );
  }

  private releaseStreamBinding(context: VoiceStreamContext): void {
    this.clearIdleLease(context);
    if (this.streams.get(context.streamId) === context) this.streams.delete(context.streamId);
    if (this.sessionStreams.get(context.sessionId) === context.streamId) {
      this.sessionStreams.delete(context.sessionId);
    }
  }
}

function isBoundedAudioRef(value: unknown): value is string {
  return typeof value === "string"
    && value.length === 73
    && AUDIO_REF_PATTERN.test(value);
}

function computeAudioRef(metadata: EphemeralAudioAssetMetadata): string {
  const canonical = JSON.stringify({
    version: 1,
    sessionId: metadata.sessionId,
    generationId: metadata.generationId,
    sourceDeliveryId: metadata.sourceDeliveryId,
    textSha256: metadata.textSha256,
    requestBasisHash: metadata.requestBasisHash,
    normalizedTextHash: metadata.normalizedTextHash,
    audioSha256: metadata.audioSha256,
    model: metadata.model,
    sampleRate: metadata.sampleRate,
    durationMs: metadata.durationMs
  });
  return `audio_v1_${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function snapshotAssetMetadata(input: EphemeralAudioAssetMetadata): EphemeralAudioAssetMetadata {
  const sessionId = SessionIdSchema.parse(input.sessionId);
  const generationId = GenerationIdSchema.parse(input.generationId);
  const sourceDeliveryId = DeliveryIdSchema.parse(input.sourceDeliveryId);
  const hashes = [
    input.textSha256,
    input.requestBasisHash,
    input.normalizedTextHash,
    input.audioSha256
  ];
  if (
    hashes.some((value) =>
      typeof value !== "string"
      || value.length !== 64
      || !/^[0-9a-f]{64}$/u.test(value)
    )
    || !Number.isFinite(input.durationMs)
    || input.durationMs <= 0
  ) {
    throw new Error("Ephemeral audio metadata is malformed");
  }
  const model = TtsModelIdentitySchema.parse(input.model);
  const sampleRate = TtsSampleRateSchema.parse(input.sampleRate);
  if (input.durationMs > TTS_LIMITS.maxOutputDurationMs) {
    throw new Error("Ephemeral audio duration exceeds the TTS output bound");
  }
  return Object.freeze({
    sessionId,
    generationId,
    sourceDeliveryId,
    textSha256: input.textSha256,
    requestBasisHash: input.requestBasisHash,
    normalizedTextHash: input.normalizedTextHash,
    audioSha256: input.audioSha256,
    model: Object.freeze({ ...model }),
    sampleRate,
    durationMs: input.durationMs
  });
}

function sameMetadata(left: EphemeralAudioAssetMetadata, right: EphemeralAudioAssetMetadata): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function snapshotBytes(input: Uint8Array): Uint8Array {
  if (!(input instanceof Uint8Array) || input.byteLength === 0) {
    throw new Error("Audio asset bytes must be a non-empty Uint8Array");
  }
  return Uint8Array.prototype.slice.call(input);
}

function concatenateTtsPcm(
  chunks: readonly Extract<TtsOutgoingMessage, { readonly type: "AUDIO_CHUNK" }>[],
  expectedBytes: number
): Uint8Array {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > TTS_LIMITS.maxPcmBytes) {
    throw new Error("TTS aggregate PCM size is invalid");
  }
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.audioBase64, "base64");
    if (offset + bytes.byteLength > output.byteLength) {
      throw new Error("TTS chunks exceed the declared aggregate PCM size");
    }
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (offset !== output.byteLength) {
    throw new Error("TTS chunks do not fill the declared aggregate PCM size");
  }
  return output;
}

function encodePcm16Wav(f32le: Uint8Array, sampleRate: number): Uint8Array {
  if (f32le.byteLength % 4 !== 0) throw new Error("TTS PCM byte length is not aligned to float32 samples");
  const frameCount = f32le.byteLength / 4;
  const dataBytes = frameCount * 2;
  const output = new Uint8Array(44 + dataBytes);
  const view = new DataView(output.buffer);
  writeAscii(output, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(output, 8, "WAVE");
  writeAscii(output, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(output, 36, "data");
  view.setUint32(40, dataBytes, true);

  const input = new DataView(f32le.buffer, f32le.byteOffset, f32le.byteLength);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const value = input.getFloat32(frame * 4, true);
    if (!Number.isFinite(value) || Math.abs(value) > 1) {
      throw new Error("TTS PCM contains an invalid float32 sample");
    }
    const pcm16 = value < 0
      ? Math.round(Math.max(-1, value) * 32_768)
      : Math.round(Math.min(1, value) * 32_767);
    view.setInt16(44 + frame * 2, pcm16, true);
  }
  return output;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameAudioBasis(left: SourceAudioBasis, rightInput: SourceAudioBasis): boolean {
  const right = SourceAudioBasisSchema.parse(rightInput);
  return left.streamId === right.streamId
    && left.firstSequence === right.firstSequence
    && left.lastSequence === right.lastSequence
    && left.startTimestampMs === right.startTimestampMs
    && left.endTimestampMs === right.endTimestampMs
    && left.sampleRate === right.sampleRate
    && left.sampleCount === right.sampleCount
    && left.pcmSha256 === right.pcmSha256;
}
