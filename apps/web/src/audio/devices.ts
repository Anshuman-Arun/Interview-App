import {
  AudioInfrastructureError,
  type AudioDeviceDescriptor,
  type AudioDeviceEnumeration,
  type AudioDeviceKind
} from "./types.js";

export interface AudioMediaDeviceInfoLike {
  readonly deviceId: string;
  readonly kind: MediaDeviceKind;
  readonly label: string;
}

export interface AudioMediaStreamTrackLike {
  readonly readyState?: MediaStreamTrackState;
  stop(): void;
  addEventListener(type: "ended", listener: () => void): void;
  removeEventListener(type: "ended", listener: () => void): void;
}

export interface AudioMediaStreamLike {
  getAudioTracks(): readonly AudioMediaStreamTrackLike[];
  getTracks?(): readonly AudioMediaStreamTrackLike[];
}

export interface AudioMediaDevicesLike {
  getUserMedia?(constraints: MediaStreamConstraints): Promise<AudioMediaStreamLike>;
  enumerateDevices?(): Promise<readonly AudioMediaDeviceInfoLike[]>;
  addEventListener?(type: "devicechange", listener: () => void): void;
  removeEventListener?(type: "devicechange", listener: () => void): void;
}

export class BrowserAudioDeviceManager {
  public constructor(private readonly mediaDevices: AudioMediaDevicesLike | undefined = browserMediaDevices()) {}

  public async enumerate(): Promise<AudioDeviceEnumeration> {
    const mediaDevices = this.mediaDevices;
    if (mediaDevices === undefined) {
      return { status: "UNSUPPORTED", devices: [] };
    }
    let enumerateDevices: AudioMediaDevicesLike["enumerateDevices"];
    try {
      enumerateDevices = mediaDevices.enumerateDevices;
    } catch (error) {
      if (isPermissionDenied(error)) {
        return { status: "PERMISSION_DENIED", devices: [] };
      }
      return {
        status: "FAILED",
        devices: [],
        message: safeErrorMessage(error)
      };
    }
    if (typeof enumerateDevices !== "function") {
      return { status: "UNSUPPORTED", devices: [] };
    }

    try {
      const devices = await enumerateDevices.call(mediaDevices);
      if (!Array.isArray(devices)) {
        throw new TypeError("Audio device enumeration must return an array");
      }
      const audioDevices: AudioDeviceDescriptor[] = [];
      for (const device of devices) {
        if (typeof device !== "object" || device === null) {
          throw new TypeError("Audio device enumeration contained an invalid device record");
        }
        const descriptor = toDescriptor(device);
        if (descriptor !== undefined) audioDevices.push(descriptor);
      }
      return {
        status: "AVAILABLE",
        devices: audioDevices
      };
    } catch (error) {
      if (isPermissionDenied(error)) {
        return { status: "PERMISSION_DENIED", devices: [] };
      }
      return {
        status: "FAILED",
        devices: [],
        message: safeErrorMessage(error)
      };
    }
  }

  public subscribe(listener: () => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("Audio device-change listener must be callable");
    }
    const mediaDevices = this.mediaDevices;
    if (mediaDevices === undefined) {
      throw new AudioInfrastructureError(
        "UNSUPPORTED",
        "Audio device-change notifications are unavailable"
      );
    }

    let addEventListener: AudioMediaDevicesLike["addEventListener"];
    let removeEventListener: AudioMediaDevicesLike["removeEventListener"];
    try {
      addEventListener = mediaDevices.addEventListener;
      removeEventListener = mediaDevices.removeEventListener;
    } catch (error) {
      throw new AudioInfrastructureError(
        isPermissionDenied(error) ? "PERMISSION_DENIED" : "UNSUPPORTED",
        "Audio device-change notification capabilities could not be read",
        { cause: error }
      );
    }
    if (typeof addEventListener !== "function" || typeof removeEventListener !== "function") {
      throw new AudioInfrastructureError(
        "UNSUPPORTED",
        "Audio device-change notifications are unavailable"
      );
    }

    let active = false;
    let removing = false;
    const observedListener = (): void => {
      if (!active || removing) return;
      try {
        const observerResult: unknown = listener();
        if (isPromiseLike(observerResult)) {
          void Promise.resolve(observerResult).catch(() => undefined);
        }
      } catch {
        // Device observers do not own browser listener lifecycle.
      }
    };

    try {
      addEventListener.call(mediaDevices, "devicechange", observedListener);
      active = true;
    } catch (error) {
      // subscribe() is failing and no unsubscribe handle will be returned.
      // Make any listener that the browser attached before throwing inert even
      // when best-effort rollback itself is unavailable.
      active = false;
      try {
        removeEventListener.call(mediaDevices, "devicechange", observedListener);
      } catch {
        // Failed subscription rollback is best-effort; the wrapper is inert.
      }
      throw error;
    }

    return () => {
      if (!active || removing) return;
      removing = true;
      try {
        removeEventListener.call(mediaDevices, "devicechange", observedListener);
        active = false;
      } finally {
        removing = false;
      }
    };
  }
}

export function browserMediaDevices(): AudioMediaDevicesLike | undefined {
  try {
    const navigatorValue: unknown = Reflect.get(globalThis, "navigator");
    if (typeof navigatorValue !== "object" || navigatorValue === null || !("mediaDevices" in navigatorValue)) {
      return undefined;
    }

    const mediaDevices: unknown = Reflect.get(navigatorValue, "mediaDevices");
    return isAudioMediaDevicesLike(mediaDevices) ? mediaDevices : undefined;
  } catch {
    return undefined;
  }
}

function isAudioMediaDevicesLike(value: unknown): value is AudioMediaDevicesLike {
  return typeof value === "object" && value !== null;
}

export function isPermissionDenied(error: unknown): boolean {
  const name = safeErrorName(error);
  return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  try {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return false;
  }
}

function safeErrorName(error: unknown): string {
  try {
    if (typeof error !== "object" || error === null || !("name" in error)) return "";
    return String(Reflect.get(error, "name"));
  } catch {
    return "";
  }
}

function safeErrorMessage(error: unknown): string {
  try {
    if (typeof error !== "object" || error === null || !("message" in error)) {
      return "Audio device enumeration failed";
    }
    const message = String(Reflect.get(error, "message")).trim();
    return message.length === 0 ? "Audio device enumeration failed" : message;
  } catch {
    return "Audio device enumeration failed";
  }
}

function toDescriptor(device: AudioMediaDeviceInfoLike): AudioDeviceDescriptor | undefined {
  const mediaKind = device.kind;
  if (mediaKind !== "audioinput" && mediaKind !== "audiooutput") return undefined;

  const deviceId = device.deviceId;
  const rawLabel = device.label;
  if (typeof deviceId !== "string" || typeof rawLabel !== "string") {
    throw new TypeError("Enumerated audio device metadata must use string ids and labels");
  }

  const kind: AudioDeviceKind = mediaKind === "audioinput" ? "INPUT" : "OUTPUT";
  const label = rawLabel.trim();
  return {
    kind,
    deviceId,
    label: label.length === 0 ? undefined : label,
    isDefault: deviceId === "default",
    availability: "AVAILABLE"
  };
}
