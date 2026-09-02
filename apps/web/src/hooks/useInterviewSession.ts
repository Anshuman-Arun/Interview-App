import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  RequestIdSchema,
  SessionIdSchema,
  type DeliveryId,
  type InterviewProblemPublicView,
  type RequestId,
  type SessionHistoryEntry,
  type SessionId,
  type SessionStatus,
  type StoredSessionSummary
} from "../../../../packages/domain/src/index.js";
import type {
  SessionEvaluationReadResponse,
  SessionHistoryReadResponse,
  SessionReplayReadResponse
} from "../../../../packages/replay/src/index.js";
import {
  BrowserCommandClient,
  BrowserCommandProtocolError
} from "../command-client.js";
import { BrowserSessionReadClient } from "../session-read-client.js";
import {
  RendererClient,
  type TextPresenter,
  type WhiteboardPresenter
} from "../renderer-client.js";
import {
  BrowserAudioPlayback,
  QueuedRendererAudioPlayer
} from "../audio/index.js";
import {
  BrowserVoiceClient,
  deriveDefaultVoiceBaseUrl,
  type BrowserVoiceCommit
} from "../voice-client.js";
import {
  useInterviewVoice,
  type InterviewVoiceControls,
  type InterviewVoiceState
} from "./useInterviewVoice.js";
import {
  RendererStreamConnectionError,
  consumeAuthenticatedRendererStream,
  createLoopbackAcknowledgementSender
} from "../renderer-stream.js";
import type { TldrawWhiteboardAdapter } from "../tldraw-whiteboard-adapter.js";
import type { TranscriptItem } from "../components/TranscriptFeed.js";

const RENDERER_REATTACH_MAX_ATTEMPTS = 10;
const RENDERER_REATTACH_DELAY_MS = 50;

export interface UseInterviewSessionOptions {
  readonly baseUrl?: string;
  readonly rendererStreamUrl?: string;
  readonly voiceBaseUrl?: string;
  readonly clientToken?: string;
  readonly initialSessionId?: SessionId;
  readonly whiteboardAdapter?: TldrawWhiteboardAdapter;
  readonly fetchImpl?: typeof fetch;
}

export interface UseInterviewSessionResult {
  readonly sessionId: SessionId | null;
  readonly isConnected: boolean;
  readonly isSessionStarted: boolean;
  readonly isStreaming: boolean;
  readonly sessionStatus: SessionStatus;
  readonly availableSessions: readonly StoredSessionSummary[];
  readonly transcript: readonly TranscriptItem[];
  readonly problem: InterviewProblemPublicView | null;
  readonly sequence: number;
  readonly contextEpoch: number;
  readonly error: string | null;
  readonly voice: InterviewVoiceState;
  readonly voiceControls: InterviewVoiceControls;
  readonly baseUrl: string;
  readonly isTransportManaged: boolean;
  readonly setBaseUrl: (url: string) => void;
  readonly fetchAvailableSessions: () => Promise<readonly StoredSessionSummary[]>;
  readonly readSessionEvaluation: (
    sessionId: SessionId,
    signal?: AbortSignal
  ) => Promise<SessionEvaluationReadResponse>;
  readonly readSessionReplay: (
    sessionId: SessionId,
    signal?: AbortSignal
  ) => Promise<SessionReplayReadResponse>;
  readonly readSessionHistory: (
    signal?: AbortSignal
  ) => Promise<SessionHistoryReadResponse>;
  readonly startSession: (customSessionId?: SessionId) => Promise<void>;
  readonly recoverSession: (sessionId: SessionId) => Promise<void>;
  readonly completeSession: (summary?: string) => Promise<void>;
  readonly archiveSession: (reason?: string) => Promise<void>;
  readonly submitTypedInput: (text: string) => Promise<void>;
  readonly retrySubmission: (itemId: string) => Promise<void>;
  readonly clearError: () => void;
  readonly disconnect: () => void;
}

interface PendingSubmissionRecord {
  readonly itemId: string;
  readonly sessionId: SessionId;
  readonly requestId: RequestId;
  readonly text: string;
}

interface DesktopBootstrap {
  readonly protocolVersion: 1;
  readonly commandBaseUrl: string;
  readonly rendererStreamUrl: string;
  readonly voiceBaseUrl: string;
  readonly authentication: {
    readonly mode: "DESKTOP_MANAGED";
    readonly headerValue: "desktop-managed-v1";
  };
  readonly appVersion: string;
  readonly platform: string;
}

interface DesktopBridge {
  readonly getBootstrap: () => unknown;
}

const DESKTOP_AUTH_HEADER_VALUE = "desktop-managed-v1";

function readDesktopBootstrap(): DesktopBootstrap | undefined {
  const bridge = (globalThis as typeof globalThis & {
    readonly interviewDesktop?: DesktopBridge;
  }).interviewDesktop;
  if (bridge === undefined) return undefined;

  const value = bridge.getBootstrap();
  if (typeof value !== "object" || value === null) {
    throw new Error("Desktop bootstrap data is malformed");
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, [
    "protocolVersion",
    "commandBaseUrl",
    "rendererStreamUrl",
    "voiceBaseUrl",
    "authentication",
    "appVersion",
    "platform"
  ])) {
    throw new Error("Desktop bootstrap data is malformed");
  }

  const authenticationValue = record["authentication"];
  if (typeof authenticationValue !== "object" || authenticationValue === null) {
    throw new Error("Desktop bootstrap data is malformed");
  }
  const authentication = authenticationValue as Record<string, unknown>;
  if (
    !hasExactKeys(authentication, ["mode", "headerValue"])
    || record["protocolVersion"] !== 1
    || typeof record["commandBaseUrl"] !== "string"
    || typeof record["rendererStreamUrl"] !== "string"
    || typeof record["voiceBaseUrl"] !== "string"
    || authentication["mode"] !== "DESKTOP_MANAGED"
    || authentication["headerValue"] !== DESKTOP_AUTH_HEADER_VALUE
    || typeof record["appVersion"] !== "string"
    || record["appVersion"].trim().length === 0
    || typeof record["platform"] !== "string"
    || record["platform"].trim().length === 0
  ) {
    throw new Error("Desktop bootstrap data is malformed");
  }

  return {
    protocolVersion: 1,
    commandBaseUrl: exactDesktopLoopbackOrigin(record["commandBaseUrl"]),
    rendererStreamUrl: exactDesktopRendererStreamUrl(record["rendererStreamUrl"]),
    voiceBaseUrl: exactDesktopLoopbackOrigin(record["voiceBaseUrl"]),
    authentication: {
      mode: "DESKTOP_MANAGED",
      headerValue: DESKTOP_AUTH_HEADER_VALUE
    },
    appVersion: record["appVersion"],
    platform: record["platform"]
  };
}

function hasExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function exactDesktopLoopbackOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Desktop bootstrap data is malformed");
  }
  if (
    parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== "/"
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error("Desktop bootstrap data is malformed");
  }
  return parsed.origin;
}

function exactDesktopRendererStreamUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Desktop bootstrap data is malformed");
  }
  if (
    parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== "/v1/renderer-stream"
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error("Desktop bootstrap data is malformed");
  }
  return parsed.toString();
}

export function deriveDefaultRendererStreamUrl(commandBaseUrl: string): string {
  const parsed = new URL(commandBaseUrl);
  if (
    parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== "/"
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error("Command server base URL must be an exact HTTP loopback origin");
  }
  const port = parsed.port.length === 0 ? 80 : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port >= 65535) {
    throw new Error("Command server port cannot derive a renderer stream port");
  }
  parsed.port = String(port + 1);
  return `${parsed.origin}/v1/renderer-stream`;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:43123";

function getInitialBaseUrl(optionUrl?: string): string {
  if (optionUrl) return optionUrl;
  return DEFAULT_BASE_URL;
}

export function useInterviewSession(
  options: UseInterviewSessionOptions = {}
): UseInterviewSessionResult {
  const [desktopBootstrap] = useState<DesktopBootstrap | undefined>(
    () => readDesktopBootstrap()
  );
  if (
    desktopBootstrap !== undefined
    && (
      options.clientToken !== undefined
      || options.baseUrl !== undefined
      || options.rendererStreamUrl !== undefined
      || options.voiceBaseUrl !== undefined
    )
  ) {
    throw new Error(
      "Desktop-managed transport cannot be combined with endpoint overrides or browser-token authentication"
    );
  }

  const [baseUrl, setBaseUrlState] = useState<string>(() =>
    desktopBootstrap?.commandBaseUrl ?? getInitialBaseUrl(options.baseUrl)
  );
  const clientTokenRef = useRef<string>(options.clientToken ?? "");
  const rendererStreamUrl = desktopBootstrap?.rendererStreamUrl
    ?? options.rendererStreamUrl
    ?? deriveDefaultRendererStreamUrl(baseUrl);
  const authenticationHeaderValue = desktopBootstrap?.authentication.headerValue
    ?? clientTokenRef.current;
  const [sessionId, setSessionId] = useState<SessionId | null>(
    options.initialSessionId ?? null
  );
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isSessionStarted, setIsSessionStarted] = useState<boolean>(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("CREATED");
  const [availableSessions, setAvailableSessions] = useState<readonly StoredSessionSummary[]>([]);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [transcript, setTranscript] = useState<readonly TranscriptItem[]>([]);
  const [problem, setProblem] = useState<InterviewProblemPublicView | null>(null);
  const [sequence, setSequence] = useState<number>(0);
  const [contextEpoch, setContextEpoch] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const pendingSubmissionsRef = useRef<Map<string, PendingSubmissionRecord>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);
  const rendererStreamTaskRef = useRef<Promise<void> | null>(null);
  const rendererLaunchEpochRef = useRef(0);
  const rendererRestartRef = useRef<((targetSessionId: SessionId) => void) | null>(null);
  const rendererClientRef = useRef<RendererClient | null>(null);
  const rendererAudioPlayerRef = useRef<QueuedRendererAudioPlayer | null>(null);
  const audioOutputDeviceRef = useRef<string | undefined>(undefined);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const fetchImpl = useMemo(
    () => options.fetchImpl ?? globalThis.fetch.bind(globalThis),
    [options.fetchImpl]
  );
  const authenticatedFetch = useCallback<typeof fetch>(async (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("x-interview-client-token", authenticationHeaderValue);
    return fetchImpl(input, { ...init, headers });
  }, [authenticationHeaderValue, fetchImpl]);

  const voiceBaseUrl = useMemo(
    () => desktopBootstrap?.voiceBaseUrl ?? options.voiceBaseUrl ?? deriveDefaultVoiceBaseUrl(baseUrl),
    [baseUrl, desktopBootstrap, options.voiceBaseUrl]
  );
  const audioVoiceClient = useMemo(
    () => new BrowserVoiceClient({
      baseUrl: voiceBaseUrl,
      authenticatedFetch
    }),
    [authenticatedFetch, voiceBaseUrl]
  );
  const interruptPlaybackForBargeIn = useCallback((): void => {
    const player = rendererAudioPlayerRef.current;
    player?.interruptCurrent();
    player?.clearQueued();

    // Discard any pre-barge-in delivery commands still buffered in the old SSE
    // connection. The replacement connection attaches only after the old
    // consumer has settled, so recovery can classify uncertainty first and
    // cannot replay cancelled/POSSIBLY_EXPOSED output.
    if (sessionId !== null) rendererRestartRef.current?.(sessionId);
  }, [sessionId]);
  const setAudioOutputDevice = useCallback((deviceId: string | undefined): void => {
    audioOutputDeviceRef.current = deviceId;
    rendererAudioPlayerRef.current?.setOutputDeviceId(deviceId);
  }, []);
  const onVoiceCommit = useCallback((commit: BrowserVoiceCommit): void => {
    setTranscript((previous) => {
      if (previous.some((item) => item.turnId === commit.turnId)) return previous;
      const item: TranscriptItem = {
        id: `student_${commit.turnId}`,
        role: "student",
        text: commit.text,
        status: "ACKNOWLEDGED",
        timestamp: Date.now(),
        turnId: commit.turnId,
        inputEpisodeId: commit.inputEpisodeId
      };
      return [...previous, item];
    });
  }, []);
  const voiceIntegration = useInterviewVoice({
    sessionId,
    sessionActive: isSessionStarted && sessionStatus === "ACTIVE",
    voiceBaseUrl,
    authenticatedFetch,
    speaking: isSpeaking,
    interruptPlaybackForBargeIn,
    setOutputDeviceId: setAudioOutputDevice,
    onVoiceCommit
  });

  const setBaseUrl = useCallback((url: string): void => {
    if (desktopBootstrap !== undefined) {
      throw new Error("Desktop-managed command endpoint cannot be changed by renderer state");
    }
    setBaseUrlState(url);
  }, [desktopBootstrap]);

  const getCommandClient = useCallback((): BrowserCommandClient => {
    return new BrowserCommandClient({
      baseUrl,
      ...(desktopBootstrap !== undefined
        ? { externalAuthenticationHeaderValue: desktopBootstrap.authentication.headerValue }
        : { clientToken: clientTokenRef.current }),
      fetchImpl
    });
  }, [baseUrl, desktopBootstrap, fetchImpl]);

  const getSessionReadClient = useCallback((): BrowserSessionReadClient => {
    return new BrowserSessionReadClient({
      baseUrl,
      ...(desktopBootstrap !== undefined
        ? { externalAuthenticationHeaderValue: desktopBootstrap.authentication.headerValue }
        : { clientToken: clientTokenRef.current }),
      fetchImpl
    });
  }, [baseUrl, desktopBootstrap, fetchImpl]);

  const readSessionEvaluation = useCallback((
    targetSessionId: SessionId,
    signal?: AbortSignal
  ): Promise<SessionEvaluationReadResponse> => {
    return getSessionReadClient().getEvaluation(targetSessionId, signal);
  }, [getSessionReadClient]);

  const readSessionReplay = useCallback((
    targetSessionId: SessionId,
    signal?: AbortSignal
  ): Promise<SessionReplayReadResponse> => {
    return getSessionReadClient().getReplay(targetSessionId, signal);
  }, [getSessionReadClient]);

  const readSessionHistory = useCallback((
    signal?: AbortSignal
  ): Promise<SessionHistoryReadResponse> => {
    return getSessionReadClient().getHistory(signal);
  }, [getSessionReadClient]);

  const fetchAvailableSessions = useCallback(async (): Promise<readonly StoredSessionSummary[]> => {
    try {
      const client = getCommandClient();
      const sessions = await client.listSessions();
      setAvailableSessions(sessions);
      return sessions;
    } catch {
      return [];
    }
  }, [getCommandClient]);

  const attachRendererStream = useCallback(
    async (targetSessionId: SessionId): Promise<void> => {
      if (abortControllerRef.current !== null) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      const textPresenter: TextPresenter = {
        presentText: (text: string, deliveryId: DeliveryId) => {
          setTranscript((prev) => {
            const existing = prev.find((item) => item.deliveryId === deliveryId);
            if (existing !== undefined) {
              return prev.map((item) =>
                item.deliveryId === deliveryId
                  ? { ...item, text: item.text + text, status: "COMPLETED" }
                  : item
              );
            }
            const newItem: TranscriptItem = {
              id: `ai_${deliveryId}`,
              role: "interviewer",
              text,
              status: "COMPLETED",
              deliveryId,
              timestamp: Date.now()
            };
            return [...prev, newItem];
          });
        }
      };

      rendererAudioPlayerRef.current?.dispose();
      const playback = new BrowserAudioPlayback();
      const audioPlayer = new QueuedRendererAudioPlayer(playback, {
        ...(audioOutputDeviceRef.current === undefined
          ? {}
          : { outputDeviceId: audioOutputDeviceRef.current }),
        onSpeakingChanged: setIsSpeaking,
        resolveAudioSource: (audioRef, deliveryId, signal) =>
          audioVoiceClient.resolveAudioSource(
            targetSessionId,
            audioRef,
            deliveryId,
            signal
          )
      });
      rendererAudioPlayerRef.current = audioPlayer;

      const whiteboardPresenter: WhiteboardPresenter | undefined = options.whiteboardAdapter;

      const acknowledgementSender = createLoopbackAcknowledgementSender({
        commandUrl: `${baseUrl}/v1/commands`,
        authenticatedFetch
      });

      const client = new RendererClient({
        sessionId: targetSessionId,
        acknowledgementSender,
        audioPlayer,
        textPresenter,
        ...(whiteboardPresenter !== undefined ? { whiteboardPresenter } : {})
      });
      rendererClientRef.current = client;

      setIsStreaming(true);
      setIsConnected(true);

      try {
        await consumeAuthenticatedRendererStream({
          streamUrl: rendererStreamUrl,
          sessionId: targetSessionId,
          authenticatedFetch,
          signal: controller.signal
        }, client);
      } catch (err) {
        if (!controller.signal.aborted) throw err;
      } finally {
        audioPlayer.dispose();
        if (rendererAudioPlayerRef.current === audioPlayer) {
          rendererAudioPlayerRef.current = null;
          setIsSpeaking(false);
        }
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          rendererClientRef.current = null;
          setIsStreaming(false);
          setIsConnected(false);
        }
      }
    },
    [audioVoiceClient, authenticatedFetch, baseUrl, options.whiteboardAdapter, rendererStreamUrl]
  );

  const launchRendererStream = useCallback((targetSessionId: SessionId): void => {
    const launchEpoch = rendererLaunchEpochRef.current + 1;
    rendererLaunchEpochRef.current = launchEpoch;
    const priorTask = rendererStreamTaskRef.current;
    abortControllerRef.current?.abort();

    const task = (async (): Promise<void> => {
      if (priorTask !== null) {
        await priorTask.catch(() => undefined);
      }
      if (rendererLaunchEpochRef.current !== launchEpoch) return;

      let lastError: unknown;
      for (let attempt = 0; attempt < RENDERER_REATTACH_MAX_ATTEMPTS; attempt += 1) {
        if (rendererLaunchEpochRef.current !== launchEpoch) return;
        try {
          await attachRendererStream(targetSessionId);
          if (rendererLaunchEpochRef.current !== launchEpoch) return;

          // An authenticated renderer stream is intended to live for the
          // session. Returning without a launch-epoch change means the server,
          // transport, or presentation failed/ended unexpectedly. Reattach so
          // disconnect recovery can conservatively classify any in-flight atom
          // and later QUEUED output is not stranded.
          lastError = new Error("Renderer stream ended unexpectedly");
        } catch (err) {
          if (rendererLaunchEpochRef.current !== launchEpoch) return;
          lastError = err;
        }

        if (attempt + 1 >= RENDERER_REATTACH_MAX_ATTEMPTS) break;
        const replacementConflict =
          lastError instanceof RendererStreamConnectionError
          && lastError.status === 409;
        await delay(
          replacementConflict
            ? RENDERER_REATTACH_DELAY_MS
            : Math.min(RENDERER_REATTACH_DELAY_MS * 2 ** attempt, 800)
        );
      }

      if (rendererLaunchEpochRef.current === launchEpoch) {
        setError(
          lastError instanceof Error
            ? lastError.message
            : "Renderer stream disconnected"
        );
      }
    })();
    rendererStreamTaskRef.current = task;
    void task.finally(() => {
      if (rendererStreamTaskRef.current === task) {
        rendererStreamTaskRef.current = null;
      }
    }).catch(() => undefined);
  }, [attachRendererStream]);
  rendererRestartRef.current = launchRendererStream;

  const startSession = useCallback(
    async (customSessionId?: SessionId): Promise<void> => {
      setError(null);
      const targetSessionId =
        customSessionId ??
        SessionIdSchema.parse(`session_${globalThis.crypto.randomUUID()}`);

      try {
        const client = getCommandClient();
        await client.startSession(targetSessionId);
        let problemView: InterviewProblemPublicView | null = null;
        try {
          const context = await client.getInterviewSessionContext(targetSessionId);
          problemView = context.problem ?? null;
        } catch {
          // The authoritative start already succeeded. A read-model/context
          // failure must not make the caller retry session creation.
          setError("Session started, but session context could not be loaded");
        }
        if (sessionId !== targetSessionId) {
          pendingSubmissionsRef.current.clear();
        }
        setSessionId(targetSessionId);
        setIsSessionStarted(true);
        setSessionStatus("ACTIVE");
        setProblem(problemView);
        setTranscript([]);

        launchRendererStream(targetSessionId);
      } catch (err) {
        let msg = "Failed to start interview session";
        if (err instanceof BrowserCommandProtocolError) {
          msg = `Command error [${err.code}]: HTTP ${String(err.status)}`;
        } else if (err instanceof Error) {
          msg = err.message;
        }
        setError(msg);
        throw err;
      }
    },
    [getCommandClient, launchRendererStream]
  );

  const recoverSession = useCallback(
    async (targetSessionId: SessionId): Promise<void> => {
      setError(null);
      try {
        const client = getCommandClient();
        const context = await client.getInterviewSessionContext(targetSessionId);
        const response = await client.resumeSession(targetSessionId);
        if (sessionId !== targetSessionId) {
          pendingSubmissionsRef.current.clear();
        }
        setSessionId(targetSessionId);
        setIsSessionStarted(response.started);
        setSessionStatus(response.status);
        setSequence(response.sequence);
        setContextEpoch(response.contextEpoch);
        setProblem(context.problem ?? null);

        setTranscript(response.history.map(historyEntryToTranscriptItem));

        launchRendererStream(targetSessionId);
      } catch (err) {
        let msg = "Failed to recover session";
        if (err instanceof BrowserCommandProtocolError) {
          msg = `Recovery error [${err.code}]: HTTP ${String(err.status)}`;
        } else if (err instanceof Error) {
          msg = err.message;
        }
        setError(msg);
        throw err;
      }
    },
    [getCommandClient, launchRendererStream]
  );

  const completeSession = useCallback(
    async (summary?: string): Promise<void> => {
      if (sessionId === null) return;
      setError(null);
      try {
        const client = getCommandClient();
        await client.completeSession(sessionId, summary);
        rendererAudioPlayerRef.current?.cancelAll();
        setSessionStatus("COMPLETED");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to complete session";
        setError(msg);
        throw err;
      }
    },
    [sessionId, getCommandClient]
  );

  const archiveSession = useCallback(
    async (reason?: string): Promise<void> => {
      if (sessionId === null) return;
      setError(null);
      try {
        const client = getCommandClient();
        await client.archiveSession(sessionId, reason);
        rendererAudioPlayerRef.current?.cancelAll();
        setSessionStatus("ARCHIVED");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to archive session";
        setError(msg);
        throw err;
      }
    },
    [sessionId, getCommandClient]
  );

  const submitTypedInput = useCallback(
    async (text: string): Promise<void> => {
      if (sessionId === null) {
        throw new Error("Cannot submit input without an active session");
      }

      setError(null);
      const requestId = RequestIdSchema.parse(`request_${globalThis.crypto.randomUUID()}`);
      const itemId = `student_${requestId}`;

      const pendingItem: TranscriptItem = {
        id: itemId,
        role: "student",
        text,
        status: "PENDING",
        timestamp: Date.now()
      };

      pendingSubmissionsRef.current.set(itemId, {
        itemId,
        sessionId,
        requestId,
        text
      });
      setTranscript((prev) => [...prev, pendingItem]);

      try {
        const client = getCommandClient();
        const response = await client.commitTypedInput(sessionId, text, { requestId });

        setTranscript((prev) =>
          prev.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  status: "ACKNOWLEDGED",
                  turnId: response.turnId,
                  inputEpisodeId: response.inputEpisodeId
                }
              : item
          )
        );
        pendingSubmissionsRef.current.delete(itemId);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Submission failed";
        setTranscript((prev) =>
          prev.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  status: "ERROR",
                  errorMessage: errorMsg
                }
              : item
          )
        );
        throw err;
      }
    },
    [sessionId, getCommandClient]
  );

  const retrySubmission = useCallback(
    async (itemId: string): Promise<void> => {
      if (sessionId === null) return;
      const record = pendingSubmissionsRef.current.get(itemId);
      if (record === undefined) return;
      if (record.sessionId !== sessionId) {
        pendingSubmissionsRef.current.delete(itemId);
        throw new Error("Cannot retry a submission in a different session");
      }

      setError(null);
      setTranscript((prev) =>
        prev.map((item) => {
          if (item.id === itemId) {
            const nextItem: TranscriptItem = {
              id: item.id,
              role: item.role,
              text: item.text,
              status: "PENDING",
              timestamp: item.timestamp,
              ...(item.turnId !== undefined ? { turnId: item.turnId } : {}),
              ...(item.inputEpisodeId !== undefined ? { inputEpisodeId: item.inputEpisodeId } : {}),
              ...(item.deliveryId !== undefined ? { deliveryId: item.deliveryId } : {})
            };
            return nextItem;
          }
          return item;
        })
      );

      try {
        const client = getCommandClient();
        const response = await client.commitTypedInput(sessionId, record.text, {
          requestId: record.requestId
        });

        setTranscript((prev) =>
          prev.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  status: "ACKNOWLEDGED",
                  turnId: response.turnId,
                  inputEpisodeId: response.inputEpisodeId
                }
              : item
          )
        );
        pendingSubmissionsRef.current.delete(itemId);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Retry failed";
        setTranscript((prev) =>
          prev.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  status: "ERROR",
                  errorMessage: errorMsg
                }
              : item
          )
        );
      }
    },
    [sessionId, getCommandClient]
  );

  const disconnect = useCallback((): void => {
    void voiceIntegration.voiceControls.disableMicrophone().catch(() => undefined);
    rendererLaunchEpochRef.current += 1;
    if (abortControllerRef.current !== null) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    rendererClientRef.current = null;
    rendererAudioPlayerRef.current?.dispose();
    rendererAudioPlayerRef.current = null;
    setIsSpeaking(false);
    setIsStreaming(false);
    setIsConnected(false);
  }, [voiceIntegration.voiceControls]);

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      rendererLaunchEpochRef.current += 1;
      rendererRestartRef.current = null;
      if (abortControllerRef.current !== null) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      rendererClientRef.current = null;
      rendererAudioPlayerRef.current?.dispose();
      rendererAudioPlayerRef.current = null;
    };
  }, []);

  return {
    sessionId,
    isConnected,
    isSessionStarted,
    sessionStatus,
    availableSessions,
    isStreaming,
    transcript,
    problem,
    sequence,
    contextEpoch,
    error,
    voice: voiceIntegration.voice,
    voiceControls: voiceIntegration.voiceControls,
    baseUrl,
    isTransportManaged: desktopBootstrap !== undefined,
    setBaseUrl,
    fetchAvailableSessions,
    readSessionEvaluation,
    readSessionReplay,
    readSessionHistory,
    startSession,
    recoverSession,
    completeSession,
    archiveSession,
    submitTypedInput,
    retrySubmission,
    clearError,
    disconnect
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

function historyEntryToTranscriptItem(entry: SessionHistoryEntry): TranscriptItem {
  const timestamp = Date.parse(entry.occurredAt);
  if (entry.role === "STUDENT") {
    return {
      id: `student_${entry.turnId}`,
      role: "student",
      text: entry.text,
      status: "ACKNOWLEDGED",
      timestamp,
      turnId: entry.turnId,
      inputEpisodeId: entry.inputEpisodeId
    };
  }
  return {
    id: `ai_${entry.deliveryId}`,
    role: "interviewer",
    text: entry.text,
    status: entry.status,
    timestamp,
    deliveryId: entry.deliveryId
  };
}
