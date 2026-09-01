export type AudioDeviceKind = "INPUT" | "OUTPUT";

export interface AudioDeviceDescriptor {
  readonly kind: AudioDeviceKind;
  readonly deviceId: string;
  readonly label: string | undefined;
  readonly isDefault: boolean;
  readonly availability: "AVAILABLE" | "UNAVAILABLE";
}

export type AudioDeviceEnumeration =
  | { readonly status: "AVAILABLE"; readonly devices: readonly AudioDeviceDescriptor[] }
  | { readonly status: "PERMISSION_DENIED"; readonly devices: readonly AudioDeviceDescriptor[] }
  | { readonly status: "UNSUPPORTED"; readonly devices: readonly AudioDeviceDescriptor[] }
  | { readonly status: "FAILED"; readonly devices: readonly AudioDeviceDescriptor[]; readonly message: string };

export interface AudioFrame {
  readonly sequence: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly capturedAtMs: number;
  readonly offsetMs: number;
  readonly samples: Float32Array;
}

export interface AudioFrameSink {
  readonly write: (frame: AudioFrame, signal: AbortSignal) => void | Promise<void>;
}

export interface AudioFrameProcessor {
  readonly process: (frame: AudioFrame, signal: AbortSignal) => AudioFrame | undefined | Promise<AudioFrame | undefined>;
}

export interface AudioFrameSource {
  readonly subscribe: (listener: (frame: AudioFrame) => void) => () => void;
}

export type AudioCaptureState = "IDLE" | "STARTING" | "CAPTURING" | "STOPPED" | "FAILED" | "DISPOSED";

export type AudioInfrastructureErrorCode =
  | "UNSUPPORTED"
  | "PERMISSION_DENIED"
  | "DEVICE_UNAVAILABLE"
  | "CAPTURE_FAILED"
  | "PLAYBACK_FAILED"
  | "OUTPUT_DEVICE_UNSUPPORTED"
  | "QUEUE_FULL"
  | "DUPLICATE_ID"
  | "CANCELLED"
  | "DISPOSED"
  | "INVALID_REQUEST";

export class AudioInfrastructureError extends Error {
  public constructor(
    public readonly code: AudioInfrastructureErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AudioInfrastructureError";
  }
}

export function unavailableAudioDevice(
  kind: AudioDeviceKind,
  deviceId: string,
  label?: string
): AudioDeviceDescriptor {
  return {
    kind,
    deviceId,
    label,
    isDefault: deviceId === "default",
    availability: "UNAVAILABLE"
  };
}
