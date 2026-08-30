import { useState, useCallback, useRef, useEffect } from "react";
import {
  RequestIdSchema,
  SessionIdSchema,
  type DeliveryId,
  type InterviewProblem,
  type RequestId,
  type SessionId
} from "../../../../packages/domain/src/index.js";
import { sixPeopleProblem } from "../../../../packages/problems/src/index.js";
import {
  BrowserCommandClient,
  BrowserCommandProtocolError,
  BrowserCommandTransportError
} from "../command-client.js";
import {
  RendererClient,
  type AudioPlayer,
  type TextPresenter,
  type WhiteboardPresenter
} from "../renderer-client.js";
import {
  consumeAuthenticatedRendererStream,
  createLoopbackAcknowledgementSender
} from "../renderer-stream.js";
import type { TldrawWhiteboardAdapter } from "../tldraw-whiteboard-adapter.js";
import type { TranscriptItem } from "../components/TranscriptFeed.js";

export interface UseInterviewSessionOptions {
  readonly baseUrl?: string;
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
  readonly transcript: readonly TranscriptItem[];
  readonly problem: InterviewProblem | null;
  readonly sequence: number;
  readonly contextEpoch: number;
  readonly error: string | null;
  readonly baseUrl: string;
  readonly clientToken: string;
  readonly setBaseUrl: (url: string) => void;
  readonly setClientToken: (token: string) => void;
  readonly startSession: (customSessionId?: SessionId) => Promise<void>;
  readonly recoverSession: (sessionId: SessionId) => Promise<void>;
  readonly submitTypedInput: (text: string) => Promise<void>;
  readonly retrySubmission: (itemId: string) => Promise<void>;
  readonly clearError: () => void;
  readonly disconnect: () => void;
}

interface PendingSubmissionRecord {
  readonly itemId: string;
  readonly requestId: RequestId;
  readonly text: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:43123";
const DEFAULT_CLIENT_TOKEN = "test_client_token_phase1_typed_interview_mvp_secure_01";

function getInitialBaseUrl(optionUrl?: string): string {
  if (optionUrl) return optionUrl;
  if (typeof window !== "undefined" && window.location?.search) {
    const params = new URLSearchParams(window.location.search);
    const queryUrl = params.get("apiUrl");
    if (queryUrl) return queryUrl;
  }
  return DEFAULT_BASE_URL;
}

function getInitialClientToken(optionToken?: string): string {
  if (optionToken) return optionToken;
  if (typeof window !== "undefined" && window.location?.search) {
    const params = new URLSearchParams(window.location.search);
    const queryToken = params.get("token");
    if (queryToken && queryToken.length >= 32) return queryToken;
  }
  return DEFAULT_CLIENT_TOKEN;
}

export function useInterviewSession(
  options: UseInterviewSessionOptions = {}
): UseInterviewSessionResult {
  const [baseUrl, setBaseUrl] = useState<string>(() => getInitialBaseUrl(options.baseUrl));
  const [clientToken, setClientToken] = useState<string>(() => getInitialClientToken(options.clientToken));
  const [sessionId, setSessionId] = useState<SessionId | null>(
    options.initialSessionId ?? null
  );
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isSessionStarted, setIsSessionStarted] = useState<boolean>(false);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [transcript, setTranscript] = useState<readonly TranscriptItem[]>([]);
  const [problem] = useState<InterviewProblem | null>(sixPeopleProblem);
  const [sequence, setSequence] = useState<number>(0);
  const [contextEpoch, setContextEpoch] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const pendingSubmissionsRef = useRef<Map<string, PendingSubmissionRecord>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);
  const rendererClientRef = useRef<RendererClient | null>(null);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const getCommandClient = useCallback((): BrowserCommandClient => {
    return new BrowserCommandClient({
      baseUrl,
      clientToken,
      fetchImpl
    });
  }, [baseUrl, clientToken, fetchImpl]);

  const attachRendererStream = useCallback(
    async (targetSessionId: SessionId): Promise<void> => {
      // Abort any existing stream
      if (abortControllerRef.current !== null) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const authenticatedFetch: typeof fetch = async (input, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("x-interview-client-token", clientToken);
        return fetchImpl(input, {
          ...init,
          headers
        });
      };

      const ackSender = createLoopbackAcknowledgementSender({
        commandUrl: `${baseUrl}/v1/commands`,
        authenticatedFetch
      });

      const textPresenter: TextPresenter = {
        presentText: (text: string, deliveryId: DeliveryId) => {
          setTranscript((prev) => {
            const existingIndex = prev.findIndex((item) => item.deliveryId === deliveryId);
            if (existingIndex !== -1) {
              const updated = [...prev];
              const current = updated[existingIndex];
              if (current !== undefined) {
                updated[existingIndex] = {
                  ...current,
                  text,
                  status: "EXPOSED"
                };
              }
              return updated;
            }

            const newItem: TranscriptItem = {
              id: `interviewer_${deliveryId}`,
              role: "interviewer",
              text,
              status: "EXPOSED",
              timestamp: Date.now(),
              deliveryId
            };
            return [...prev, newItem];
          });
        }
      };

      const noopAudioPlayer: AudioPlayer = {
        playAudio: async ({ callbacks }) => {
          await callbacks.onStarted();
          await callbacks.onCompleted();
        }
      };

      const whiteboardPresenter: WhiteboardPresenter | undefined =
        options.whiteboardAdapter !== undefined
          ? {
              presentWhiteboard: async (action, deliveryId) => {
                if (options.whiteboardAdapter !== undefined) {
                  await options.whiteboardAdapter.presentWhiteboard(action, deliveryId);
                }
              }
            }
          : undefined;

      const renderer = new RendererClient({
        sessionId: targetSessionId,
        acknowledgementSender: ackSender,
        textPresenter,
        audioPlayer: noopAudioPlayer,
        ...(whiteboardPresenter !== undefined ? { whiteboardPresenter } : {})
      });

      rendererClientRef.current = renderer;
      setIsStreaming(true);

      try {
        await consumeAuthenticatedRendererStream(
          {
            streamUrl: `${baseUrl}/v1/renderer-stream`,
            sessionId: targetSessionId,
            authenticatedFetch,
            signal: abortController.signal
          },
          renderer
        );
      } catch (streamErr) {
        if (!abortController.signal.aborted) {
          const errMessage = streamErr instanceof Error ? streamErr.message : "Stream disconnected";
          setError(`Renderer stream error: ${errMessage}`);
        }
      } finally {
        if (abortControllerRef.current === abortController) {
          setIsStreaming(false);
        }
      }
    },
    [baseUrl, clientToken, fetchImpl, options.whiteboardAdapter]
  );

  const startSession = useCallback(
    async (customSessionId?: SessionId): Promise<void> => {
      setError(null);
      const sid =
        customSessionId ??
        SessionIdSchema.parse(`session_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`);

      try {
        const client = getCommandClient();
        await client.startSession(sid);
        setSessionId(sid);
        setIsConnected(true);
        setIsSessionStarted(true);
        void attachRendererStream(sid);
      } catch (err) {
        let msg = "Failed to start session";
        if (err instanceof BrowserCommandProtocolError) {
          msg = `Protocol error [${err.code}]: HTTP ${String(err.status)}`;
        } else if (err instanceof BrowserCommandTransportError) {
          msg = `Transport error: ${err.kind}`;
        } else if (err instanceof Error) {
          msg = err.message;
        }
        setError(msg);
        throw err;
      }
    },
    [getCommandClient, attachRendererStream]
  );

  const recoverSession = useCallback(
    async (targetSessionId: SessionId): Promise<void> => {
      setError(null);
      try {
        const client = getCommandClient();
        const summary = await client.getSessionSummary(targetSessionId);
        setSessionId(targetSessionId);
        setIsConnected(true);
        setIsSessionStarted(summary.started);
        setSequence(summary.sequence);
        setContextEpoch(summary.contextEpoch);

        // Update transcript delivery statuses from summary
        setTranscript((prev) =>
          prev.map((item) => {
            if (item.deliveryId !== undefined && item.deliveryId in summary.deliveryStatuses) {
              const updatedStatus = summary.deliveryStatuses[item.deliveryId];
              if (updatedStatus !== undefined) {
                return {
                  ...item,
                  status: updatedStatus
                };
              }
            }
            return item;
          })
        );

        void attachRendererStream(targetSessionId);
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
    [getCommandClient, attachRendererStream]
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

      pendingSubmissionsRef.current.set(itemId, { itemId, requestId, text });
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
    if (abortControllerRef.current !== null) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setIsConnected(false);
  }, []);

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current !== null) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  return {
    sessionId,
    isConnected,
    isSessionStarted,
    isStreaming,
    transcript,
    problem,
    sequence,
    contextEpoch,
    error,
    baseUrl,
    clientToken,
    setBaseUrl,
    setClientToken,
    startSession,
    recoverSession,
    submitTypedInput,
    retrySubmission,
    clearError,
    disconnect
  };
}
