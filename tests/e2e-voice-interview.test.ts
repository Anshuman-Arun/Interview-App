import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  newSessionId,
  type DeliveryId,
  type SessionId
} from "../packages/domain/src/index.js";
import {
  DeterministicFakeRecognizer,
  DeterministicFakeSpeechSynthesizer,
  ScriptedVadBackend,
  SpeechWorkerCore,
  TtsWorkerCore,
  type RecognizerAudioInput
} from "../packages/local-compute/src/index.js";
import {
  TurnCoordinator
} from "../packages/interview-engine/src/index.js";
import { BrowserCommandClient } from "../apps/web/src/command-client.js";
import {
  RendererClient,
  type TextPresenter
} from "../apps/web/src/renderer-client.js";
import {
  BrowserAudioPlayback,
  QueuedRendererAudioPlayer,
  type AudioFrame,
  type BrowserAudioElementLike
} from "../apps/web/src/audio/index.js";
import { BrowserVoiceClient } from "../apps/web/src/voice-client.js";
import { applyAdmittedVoiceFrameResult } from "../apps/web/src/hooks/useInterviewVoice.js";
import {
  consumeAuthenticatedRendererStream,
  createLoopbackAcknowledgementSender
} from "../apps/web/src/renderer-stream.js";
import { createAndStartServer } from "../apps/server/src/server.js";

const TEST_CLIENT_TOKEN = "voice_e2e_test_token_minimum_32_characters_001";
const TEST_ORIGIN = "http://127.0.0.1:5173";

type ServerInstance = Awaited<ReturnType<typeof createAndStartServer>>;

class ControlledAudioElement implements BrowserAudioElementLike {
  public src = "";
  public preload = "";
  public currentTime = 0;
  public pauseCount = 0;
  public loadCount = 0;
  public playCount = 0;
  private readonly listeners = new Map<"playing" | "ended" | "error", Set<() => void>>([
    ["playing", new Set()],
    ["ended", new Set()],
    ["error", new Set()]
  ]);

  public async play(): Promise<void> {
    this.playCount += 1;
    queueMicrotask(() => this.emit("playing"));
  }

  public pause(): void {
    this.pauseCount += 1;
  }

  public load(): void {
    this.loadCount += 1;
  }

  public addEventListener(
    type: "playing" | "ended" | "error",
    listener: () => void
  ): void {
    this.listeners.get(type)?.add(listener);
  }

  public removeEventListener(
    type: "playing" | "ended" | "error",
    listener: () => void
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  public removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  public emit(type: "playing" | "ended" | "error"): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

function voiceRuntime(
  probabilities: readonly number[],
  transcriptFactory?: (input: RecognizerAudioInput) => string
) {
  const recognizer = transcriptFactory === undefined
    ? new DeterministicFakeRecognizer()
    : new DeterministicFakeRecognizer((input) => ({
        requestId: input.requestId,
        utteranceId: input.utteranceId,
        text: transcriptFactory(input),
        isFinal: true,
        model: { name: "deterministic-fake", version: "1" },
        sourceAudioBasis: input.sourceAudioBasis
      }));

  return {
    speechWorker: new SpeechWorkerCore({
      vadBackend: new ScriptedVadBackend(probabilities),
      recognizer
    }),
    tts: {
      worker: new TtsWorkerCore(new DeterministicFakeSpeechSynthesizer()),
      voice: "fake-neutral",
      language: "en-US" as const,
      sampleRate: 24_000 as const,
      speed: 1
    }
  };
}

function authenticatedFetch(): typeof fetch {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", TEST_ORIGIN);
    headers.set("x-interview-client-token", TEST_CLIENT_TOKEN);
    return fetch(input, { ...init, headers });
  };
}

function microphoneFrame(amplitude: number, durationMs = 100): AudioFrame {
  const sampleRate = 48_000;
  const sampleCount = Math.round(sampleRate * durationMs / 1_000);
  const samples = new Float32Array(sampleCount);
  samples.fill(amplitude);
  return {
    sequence: 0,
    sampleRate,
    channelCount: 1,
    capturedAtMs: 0,
    offsetMs: 0,
    samples
  };
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("voice input, TTS delivery, and authoritative barge-in", () => {
  let server: ServerInstance | undefined;
  let rendererAbort: AbortController | undefined;
  let rendererPromise: Promise<void> | undefined;
  let audioPlayer: QueuedRendererAudioPlayer | undefined;

  afterEach(async () => {
    rendererAbort?.abort();
    await rendererPromise?.catch(() => undefined);
    audioPlayer?.dispose();
    rendererAbort = undefined;
    rendererPromise = undefined;
    audioPlayer = undefined;
    if (server !== undefined) {
      await server.stop();
      server = undefined;
    }
  });

  it("runs the deterministic voice vertical slice through physical audio interruption and a new turn", async () => {
    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      voicePort: 0,
      clientToken: TEST_CLIENT_TOKEN,
      allowedOrigins: [TEST_ORIGIN],
      databasePath: ":memory:",
      voiceRuntime: voiceRuntime([1, 1, 0, 0, 0, 0, 0], () => "I would first isolate the symmetric case.")
    });

    const fetchWithAuth = authenticatedFetch();
    const commandClient = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken: TEST_CLIENT_TOKEN,
      fetchImpl: fetchWithAuth
    });
    const voiceClient = new BrowserVoiceClient({
      baseUrl: server.bound.voice.url,
      authenticatedFetch: fetchWithAuth
    });
    const sessionId: SessionId = newSessionId();
    await commandClient.startSession(sessionId);

    const presentedTexts: Array<{ readonly text: string; readonly deliveryId: DeliveryId }> = [];
    const textPresenter: TextPresenter = {
      presentText: (text, deliveryId) => {
        presentedTexts.push({ text, deliveryId });
      }
    };
    const elements: ControlledAudioElement[] = [];
    const playback = new BrowserAudioPlayback(() => {
      const element = new ControlledAudioElement();
      elements.push(element);
      return element;
    });
    audioPlayer = new QueuedRendererAudioPlayer(playback, {
      resolveAudioSource: (audioRef, deliveryId, signal) =>
        voiceClient.resolveAudioSource(sessionId, audioRef, deliveryId, signal)
    });
    const renderer = new RendererClient({
      sessionId,
      acknowledgementSender: createLoopbackAcknowledgementSender({
        commandUrl: `${server.bound.command.url}/v1/commands`,
        authenticatedFetch: fetchWithAuth
      }),
      textPresenter,
      audioPlayer
    });

    rendererAbort = new AbortController();
    rendererPromise = consumeAuthenticatedRendererStream({
      streamUrl: server.bound.rendererStream.streamUrl,
      sessionId,
      authenticatedFetch: fetchWithAuth,
      signal: rendererAbort.signal
    }, renderer);
    await waitFor(
      () => server?.runtime.rendererStreamServer.activeConnectionCount() === 1,
      "renderer connection"
    );

    const firstTurn = await commandClient.commitTypedInput(
      sessionId,
      "Let me begin by looking at the symmetry of the configuration."
    );
    const writer = server.registry.get(sessionId);

    await waitFor(() => {
      const state = writer.getState();
      return Object.values(state.deliveries).some(
        (atom) => atom.content.medium === "AUDIO" && atom.status === "EXPOSED"
      );
    }, "authoritative audio exposure");

    const beforeBargeIn = writer.getState();
    const oldGeneration = Object.values(beforeBargeIn.generations).find(
      (generation) => generation.basis.turnId === firstTurn.turnId
    );
    if (oldGeneration === undefined) throw new Error("Expected first interviewer generation");
    const sourceText = Object.values(beforeBargeIn.deliveries).find(
      (atom) =>
        atom.generationId === oldGeneration.generationId
        && atom.content.medium === "TEXT"
    );
    if (sourceText === undefined || sourceText.content.medium !== "TEXT") {
      throw new Error("Expected validated interviewer speech text");
    }
    const firstAudio = Object.values(beforeBargeIn.deliveries).find(
      (atom) =>
        atom.generationId === oldGeneration.generationId
        && atom.content.medium === "AUDIO"
    );
    if (firstAudio === undefined) throw new Error("Expected authoritative AUDIO delivery");
    expect(firstAudio.disclosureIds).toEqual(sourceText.disclosureIds);
    expect(firstAudio.effectiveDisclosureLevel).toBe(sourceText.effectiveDisclosureLevel);
    expect(firstAudio.content.medium).toBe("AUDIO");
    if (firstAudio.content.medium === "AUDIO") {
      expect(firstAudio.content.text).toBe(sourceText.content.text);
      expect(firstAudio.content.audioRef).toMatch(/^audio_v1_[0-9a-f]{64}$/u);
    }
    expect(elements[0]?.playCount).toBe(1);

    const speech = await voiceClient.openStream(sessionId);
    const onset = await speech.sendFrame(microphoneFrame(0.2));
    expect(onset.events.some((event) => event.type === "SPEECH_STARTED")).toBe(true);

    const afterOnset = writer.getState();
    expect(afterOnset.generations[oldGeneration.generationId]?.status).toBe("SUPERSEDED");

    applyAdmittedVoiceFrameResult(onset, {
      interruptPlaybackForBargeIn: () => {
        audioPlayer?.interruptCurrent();
        audioPlayer?.clearQueued();
      },
      onVoiceCommit: () => undefined
    });
    expect(elements[0]?.pauseCount).toBeGreaterThanOrEqual(1);

    const lateAudio = await new TurnCoordinator(writer).queueAudioDeliveryFromValidatedText({
      sourceDeliveryId: sourceText.deliveryId,
      generationId: oldGeneration.generationId,
      text: sourceText.content.text,
      textSha256: createHash("sha256").update(sourceText.content.text, "utf8").digest("hex"),
      audioRef: `audio_v1_${"f".repeat(64)}`
    });
    expect(lateAudio).toBeUndefined();

    await speech.sendFrame(microphoneFrame(0.2));
    let committedTurnId: string | undefined;
    for (let index = 0; index < 5; index += 1) {
      const result = await speech.sendFrame(microphoneFrame(0));
      if (result.commit !== undefined) committedTurnId = result.commit.turnId;
      if (result.terminal) break;
    }
    expect(committedTurnId).toBeDefined();

    await waitFor(() => {
      if (committedTurnId === undefined) return false;
      const state = writer.getState();
      return Object.values(state.generations).some(
        (generation) => generation.basis.turnId === committedTurnId
      );
    }, "normal orchestration for committed voice turn");

    const finalState = writer.getState();
    if (committedTurnId === undefined) throw new Error("Expected committed voice turn");
    expect(finalState.turns[committedTurnId]?.studentText)
      .toBe("I would first isolate the symmetric case.");
    expect(presentedTexts.length).toBeGreaterThanOrEqual(1);
  });

  it("does not barge in on a false VAD onset", async () => {
    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      voicePort: 0,
      clientToken: TEST_CLIENT_TOKEN,
      allowedOrigins: [TEST_ORIGIN],
      databasePath: ":memory:",
      voiceRuntime: voiceRuntime([1, 0])
    });
    const fetchWithAuth = authenticatedFetch();
    const commandClient = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken: TEST_CLIENT_TOKEN,
      fetchImpl: fetchWithAuth
    });
    const sessionId: SessionId = newSessionId();
    await commandClient.startSession(sessionId);
    const firstTurn = await commandClient.commitTypedInput(sessionId, "I am thinking about a graph model.");
    const writer = server.registry.get(sessionId);
    await waitFor(
      () => Object.values(writer.getState().generations).some(
        (generation) =>
          generation.basis.turnId === firstTurn.turnId
          && generation.status === "VALIDATED"
      ),
      "validated generation before false onset"
    );

    const generation = Object.values(writer.getState().generations).find(
      (candidate) => candidate.basis.turnId === firstTurn.turnId
    );
    if (generation === undefined) throw new Error("Expected generation before false onset");

    const voiceClient = new BrowserVoiceClient({
      baseUrl: server.bound.voice.url,
      authenticatedFetch: fetchWithAuth
    });
    const speech = await voiceClient.openStream(sessionId);
    const candidate = await speech.sendFrame(microphoneFrame(0.2, 20));
    expect(candidate.events.some((event) => event.type === "SPEECH_STARTED")).toBe(false);

    const rejected = await speech.sendFrame(microphoneFrame(0, 20));
    expect(rejected.events.some(
      (event) => event.type === "UTTERANCE_DISCARDED" && event.reason === "FALSE_START"
    )).toBe(true);
    expect(writer.getState().generations[generation.generationId]?.status).toBe("VALIDATED");
    expect(Object.keys(writer.getState().utterances)).toHaveLength(0);
  });

  it("discards an empty final transcript instead of committing a meaningless turn", async () => {
    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      voicePort: 0,
      clientToken: TEST_CLIENT_TOKEN,
      allowedOrigins: [TEST_ORIGIN],
      databasePath: ":memory:",
      voiceRuntime: voiceRuntime([1, 1, 0, 0, 0, 0, 0], () => "")
    });
    const fetchWithAuth = authenticatedFetch();
    const commandClient = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken: TEST_CLIENT_TOKEN,
      fetchImpl: fetchWithAuth
    });
    const sessionId: SessionId = newSessionId();
    await commandClient.startSession(sessionId);

    const voiceClient = new BrowserVoiceClient({
      baseUrl: server.bound.voice.url,
      authenticatedFetch: fetchWithAuth
    });
    const speech = await voiceClient.openStream(sessionId);
    await speech.sendFrame(microphoneFrame(0.2));
    await speech.sendFrame(microphoneFrame(0.2));

    let terminal = false;
    let committed = false;
    for (let index = 0; index < 5; index += 1) {
      const result = await speech.sendFrame(microphoneFrame(0));
      terminal ||= result.terminal;
      committed ||= result.commit !== undefined;
      if (result.terminal) break;
    }
    expect(terminal).toBe(true);
    expect(committed).toBe(false);

    const state = server.registry.get(sessionId).getState();
    expect(Object.keys(state.turns)).toHaveLength(0);
    expect(Object.values(state.utterances).some(
      (utterance) => utterance.status === "DISCARDED"
    )).toBe(true);
  });

  it("enforces voice transport origin, authentication, frame size, and sequence binding", async () => {
    server = await createAndStartServer({
      host: "127.0.0.1",
      commandPort: 0,
      rendererStreamPort: 0,
      voicePort: 0,
      clientToken: TEST_CLIENT_TOKEN,
      allowedOrigins: [TEST_ORIGIN],
      databasePath: ":memory:",
      voiceRuntime: voiceRuntime([0])
    });
    const fetchWithAuth = authenticatedFetch();
    const commandClient = new BrowserCommandClient({
      baseUrl: server.bound.command.url,
      clientToken: TEST_CLIENT_TOKEN,
      fetchImpl: fetchWithAuth
    });
    const sessionId: SessionId = newSessionId();
    await commandClient.startSession(sessionId);

    const forbidden = await fetch(`${server.bound.voice.url}/v1/voice/streams`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "http://attacker.invalid",
        "x-interview-client-token": TEST_CLIENT_TOKEN
      },
      body: JSON.stringify({
        protocolVersion: 1,
        sessionId,
        streamId: "speech_stream_forbidden",
        sampleRate: 48_000
      })
    });
    expect(forbidden.status).toBe(403);

    const unauthorized = await fetch(`${server.bound.voice.url}/v1/voice/streams`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: TEST_ORIGIN,
        "x-interview-client-token": "x".repeat(32)
      },
      body: JSON.stringify({
        protocolVersion: 1,
        sessionId,
        streamId: "speech_stream_unauthorized",
        sampleRate: 48_000
      })
    });
    expect(unauthorized.status).toBe(401);

    const voiceClient = new BrowserVoiceClient({
      baseUrl: server.bound.voice.url,
      authenticatedFetch: fetchWithAuth
    });
    const stream = await voiceClient.openStream(sessionId);

    const commonHeaders = {
      "content-type": "application/octet-stream",
      "x-interview-session-id": sessionId,
      "x-speech-stream-id": stream.streamId,
      "x-speech-request-id": "request_sequence_gap",
      "x-speech-sequence": "1",
      "x-speech-sample-rate": "48000",
      "x-speech-frame-samples": "4800",
      "x-speech-timestamp-ms": "0"
    };
    const sequenceGap = await fetchWithAuth(
      `${server.bound.voice.url}/v1/voice/frames`,
      {
        method: "POST",
        headers: commonHeaders,
        body: new Uint8Array(4_800 * 4)
      }
    );
    expect(sequenceGap.status).toBe(409);

    const oversized = await fetchWithAuth(
      `${server.bound.voice.url}/v1/voice/frames`,
      {
        method: "POST",
        headers: {
          ...commonHeaders,
          "x-speech-request-id": "request_oversized",
          "x-speech-sequence": "0",
          "x-speech-frame-samples": "4801"
        },
        body: new Uint8Array(4)
      }
    );
    expect(oversized.status).toBe(413);
  });
});
