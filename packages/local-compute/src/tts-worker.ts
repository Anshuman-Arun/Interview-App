import {
  TTS_PROTOCOL_VERSION,
  TtsErrorCodeSchema,
  TtsIncomingMessageSchema,
  TtsOutgoingMessageSchema,
  TtsWorkerErrorResultSchema,
  type TtsCancellationResult,
  type TtsErrorCode,
  type TtsOutgoingMessage
} from "./tts-protocol.js";
import { TtsWorkerError, type SpeechSynthesizer } from "./tts-core.js";
import {
  TtsRequestManager,
  type TtsManagerInspection,
  type TtsRunSummary
} from "./tts-request-manager.js";

export type TtsWorkerOutputSink = (message: TtsOutgoingMessage) => void | Promise<void>;

export type TtsWorkerHandleResult =
  | {
      readonly kind: "SYNTHESIS";
      readonly summary: TtsRunSummary;
    }
  | {
      readonly kind: "CANCELLATION";
      readonly result: TtsCancellationResult;
    };

const ERROR_MESSAGES: Readonly<Record<TtsErrorCode, string>> = Object.freeze({
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

function safeWorkerError(error: unknown): TtsWorkerError {
  try {
    if (error instanceof TtsWorkerError) {
      const parsedCode = TtsErrorCodeSchema.safeParse(error.code);
      if (parsedCode.success) {
        return new TtsWorkerError(parsedCode.data, ERROR_MESSAGES[parsedCode.data]);
      }
    }
  } catch {
    // Treat hostile error objects exactly like an unknown internal failure.
  }
  return new TtsWorkerError("INTERNAL_ERROR", ERROR_MESSAGES.INTERNAL_ERROR);
}

export class TtsWorkerCore {
  private readonly manager: TtsRequestManager;

  public constructor(synthesizer: SpeechSynthesizer) {
    this.manager = new TtsRequestManager(synthesizer);
  }

  public async handle(input: unknown, sink: TtsWorkerOutputSink): Promise<TtsWorkerHandleResult> {
    let parsed: ReturnType<typeof TtsIncomingMessageSchema.safeParse>;
    try {
      parsed = TtsIncomingMessageSchema.safeParse(input);
    } catch {
      throw new TtsWorkerError("INVALID_REQUEST", ERROR_MESSAGES.INVALID_REQUEST);
    }
    if (!parsed.success) {
      throw new TtsWorkerError("INVALID_REQUEST", ERROR_MESSAGES.INVALID_REQUEST);
    }

    if (parsed.data.type === "CANCEL_SYNTHESIS") {
      const result = await this.manager.cancel(parsed.data);
      await this.emit(sink, result);
      return Object.freeze({ kind: "CANCELLATION", result });
    }

    try {
      const summary = await this.manager.run(
        parsed.data,
        async (message) => this.emit(sink, message)
      );
      return Object.freeze({ kind: "SYNTHESIS", summary });
    } catch (error) {
      const safe = safeWorkerError(error);
      const errorResult = TtsWorkerErrorResultSchema.parse({
        protocolVersion: TTS_PROTOCOL_VERSION,
        type: "TTS_ERROR",
        requestId: parsed.data.requestId,
        code: safe.code,
        message: ERROR_MESSAGES[safe.code]
      });
      try {
        await this.emit(sink, errorResult);
      } catch {
        // Preserve the original bounded synthesis failure even if the transport is also unavailable.
      }
      throw safe;
    }
  }

  public inspect(): TtsManagerInspection {
    return this.manager.inspect();
  }

  public async shutdown(): Promise<void> {
    await this.manager.shutdown();
  }

  private async emit(sink: TtsWorkerOutputSink, message: TtsOutgoingMessage): Promise<void> {
    const validated = TtsOutgoingMessageSchema.parse(message);
    try {
      await sink(validated);
    } catch {
      throw new TtsWorkerError("INTERNAL_ERROR", ERROR_MESSAGES.INTERNAL_ERROR);
    }
  }
}
