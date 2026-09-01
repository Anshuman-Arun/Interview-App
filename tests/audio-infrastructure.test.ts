import { describe, expect, it } from "vitest";
import {
  newDeliveryId,
  newSessionId
} from "../packages/domain/src/index.js";
import { RendererStreamMessageSchema } from "../packages/delivery/src/index.js";
import {
  RendererClient,
  RendererPresentationNotExposedError
} from "../apps/web/src/renderer-client.js";
import {
  AudioCancellationController,
  AudioInfrastructureError,
  BoundedAudioFrameBuffer,
  BrowserAudioDeviceManager,
  BrowserAudioPlayback,
  BrowserMicrophoneCapture,
  QueuedRendererAudioPlayer,
  defaultCaptureEnvironment,
  unavailableAudioDevice,
  type AudioFrame,
  type AudioMediaDeviceInfoLike,
  type AudioMediaDevicesLike,
  type AudioMediaStreamLike,
  type AudioMediaStreamTrackLike,
  type BrowserAudioElementLike,
  type BrowserMicrophoneCaptureEnvironment,
  type MicrophoneCaptureOptions,
  type PlayableAudio,
  type CaptureAudioBufferLike,
  type CaptureAudioContextLike,
  type CaptureAudioNodeLike,
  type CaptureAudioProcessEventLike,
  type CaptureScriptProcessorLike
} from "../apps/web/src/audio/index.js";

function frame(sequence: number): AudioFrame {
  return {
    sequence,
    sampleRate: 16_000,
    channelCount: 1,
    capturedAtMs: sequence * 10,
    offsetMs: sequence * 10,
    samples: new Float32Array([sequence])
  };
}

function proxyGet(target: object, property: PropertyKey, receiver: unknown): unknown {
  const value: unknown = Reflect.get(target, property, receiver);
  return value;
}

function asVoidCallback<Args extends unknown[]>(
  callback: (...args: Args) => Promise<void>
): (...args: Args) => void {
  return callback;
}

describe("bounded audio buffering", () => {
  it("preserves order, drops oldest on overflow, clears, and remains reusable", () => {
    const buffer = new BoundedAudioFrameBuffer(2);
    expect(buffer.push(frame(1))).toEqual({ accepted: true, droppedOldest: undefined });
    expect(buffer.push(frame(2))).toEqual({ accepted: true, droppedOldest: undefined });

    const overflow = buffer.push(frame(3));
    expect(overflow.accepted).toBe(true);
    expect(overflow.droppedOldest?.sequence).toBe(1);
    expect(buffer.snapshot().map((item) => item.sequence)).toEqual([2, 3]);
    expect(buffer.shift()?.sequence).toBe(2);

    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.push(frame(4)).accepted).toBe(true);
    expect(buffer.peek()?.sequence).toBe(4);
  });

  it("owns buffered PCM instead of retaining caller-mutable aliases", () => {
    const buffer = new BoundedAudioFrameBuffer(2);
    const original = frame(1);
    buffer.push(original);

    original.samples[0] = 99;
    expect(buffer.peek()?.samples[0]).toBe(1);

    const peeked = buffer.peek();
    if (peeked === undefined) throw new Error("Expected buffered frame");
    peeked.samples[0] = 77;
    expect(buffer.peek()?.samples[0]).toBe(1);

    const snapshot = buffer.snapshot();
    const snapshotFrame = snapshot[0];
    if (snapshotFrame === undefined) throw new Error("Expected snapshot frame");
    snapshotFrame.samples[0] = 55;
    expect(buffer.peek()?.samples[0]).toBe(1);

    const shifted = buffer.shift();
    expect(shifted?.samples[0]).toBe(1);
  });

  it("copies PCM before validation so hostile typed-array species cannot alter admitted samples", () => {
    const buffer = new BoundedAudioFrameBuffer(2);
    class MutatingSpeciesPcm extends Float32Array {
      public static get [Symbol.species](): Float32ArrayConstructor {
        source[0] = Number.NaN;
        return Float32Array;
      }
    }

    const source = new MutatingSpeciesPcm([1]);
    const hostile = {
      ...frame(1),
      samples: source
    };

    expect(buffer.push(hostile).accepted).toBe(true);
    expect(buffer.peek()?.samples[0]).toBe(1);
    expect(source[0]).toBe(1);
  });

  it("does not evict valid buffered audio if cloning an incoming frame fails", () => {
    const buffer = new BoundedAudioFrameBuffer(2);
    buffer.push(frame(1));
    buffer.push(frame(2));

    const malformed = frame(3) as AudioFrame & { samples: Float32Array };
    Object.defineProperty(malformed, "samples", {
      get: () => {
        throw new Error("samples unavailable");
      }
    });

    expect(() => buffer.push(malformed)).toThrow(/samples unavailable/u);
    expect(buffer.snapshot().map((item) => item.sequence)).toEqual([1, 2]);
  });

  it("does not let a frame getter repopulate the buffer after a reentrant clear", () => {
    const buffer = new BoundedAudioFrameBuffer(2);
    buffer.push(frame(1));
    const hostile = frame(2) as AudioFrame & { sequence: number };
    Object.defineProperty(hostile, "sequence", {
      get: () => {
        buffer.clear();
        return 2;
      }
    });

    expect(buffer.push(hostile)).toEqual({
      accepted: false,
      droppedOldest: undefined
    });
    expect(buffer.isCancelled).toBe(false);
    expect(buffer.snapshot()).toEqual([]);

    expect(buffer.push(frame(3)).accepted).toBe(true);
    expect(buffer.peek()?.sequence).toBe(3);
  });

  it("does not admit a frame if its getter cancels the buffer during snapshot", () => {
    const buffer = new BoundedAudioFrameBuffer(2);
    buffer.push(frame(1));
    const hostile = frame(2) as AudioFrame & { sequence: number };
    Object.defineProperty(hostile, "sequence", {
      get: () => {
        buffer.cancel();
        return 2;
      }
    });

    expect(buffer.push(hostile)).toEqual({
      accepted: false,
      droppedOldest: undefined
    });
    expect(buffer.isCancelled).toBe(true);
    expect(buffer.size).toBe(0);
    expect(buffer.snapshot()).toEqual([]);
  });

  it("validates the owned frame snapshot instead of rereading hostile caller getters", () => {
    const buffer = new BoundedAudioFrameBuffer(2);
    const hostile = frame(2) as AudioFrame & { sequence: number };
    let sequenceReads = 0;
    Object.defineProperty(hostile, "sequence", {
      get: () => {
        sequenceReads += 1;
        return sequenceReads === 1 ? 2 : -1;
      }
    });

    buffer.push(hostile);

    expect(sequenceReads).toBe(1);
    expect(buffer.peek()?.sequence).toBe(2);
  });

  it("rejects malformed normalized frames without evicting buffered audio", () => {
    const buffer = new BoundedAudioFrameBuffer(2);
    buffer.push(frame(1));

    const malformedFrames: AudioFrame[] = [
      { ...frame(2), sequence: -1 },
      { ...frame(2), sampleRate: Number.POSITIVE_INFINITY },
      { ...frame(2), channelCount: 0 },
      { ...frame(2), capturedAtMs: Number.NaN },
      { ...frame(2), offsetMs: -1 },
      { ...frame(2), samples: null } as never,
      { ...frame(2), samples: 123 } as never,
      { ...frame(2), samples: new Float32Array() },
      { ...frame(2), channelCount: 2, samples: new Float32Array([0.1]) },
      { ...frame(2), samples: new Float32Array([Number.NaN]) }
    ];

    for (const malformed of malformedFrames) {
      expect(() => buffer.push(malformed)).toThrow();
      expect(buffer.snapshot().map((item) => item.sequence)).toEqual([1]);
    }
    expect(() => buffer.push(null as never)).toThrow(/frame must be an object/u);
  });

  it("cancels idempotently, clears frames, and rejects future pushes", () => {
    const buffer = new BoundedAudioFrameBuffer(2);
    buffer.push(frame(1));
    buffer.cancel();
    buffer.cancel();

    expect(buffer.isCancelled).toBe(true);
    expect(buffer.size).toBe(0);
    expect(buffer.push(frame(2))).toEqual({ accepted: false, droppedOldest: undefined });
    expect(buffer.shift()).toBeUndefined();
  });

  it("rejects zero, fractional, and unsafe capacities", () => {
    expect(() => new BoundedAudioFrameBuffer(0)).toThrow(/positive safe integer/u);
    expect(() => new BoundedAudioFrameBuffer(1.5)).toThrow(/positive safe integer/u);
    expect(() => new BoundedAudioFrameBuffer(Number.MAX_SAFE_INTEGER + 1)).toThrow(/positive safe integer/u);
  });

  it("keeps validated buffer capacity immutable through ordinary runtime assignment", () => {
    const buffer = new BoundedAudioFrameBuffer(2);

    expect(Reflect.set(buffer, "capacity", 0)).toBe(false);
    expect(buffer.capacity).toBe(2);
    expect(buffer.push(frame(1)).accepted).toBe(true);
    expect(buffer.push(frame(2)).accepted).toBe(true);
    expect(buffer.push(frame(3)).droppedOldest?.sequence).toBe(1);
  });
});

describe("audio cancellation primitive", () => {
  it("is idempotent and exposes an AbortSignal", () => {
    const cancellation = new AudioCancellationController();
    expect(cancellation.cancelled).toBe(false);

    cancellation.cancel("stop capture");
    cancellation.cancel("ignored second reason");

    expect(cancellation.cancelled).toBe(true);
    expect(cancellation.signal.aborted).toBe(true);
    expect(() => cancellation.throwIfCancelled()).toThrow(/stop capture/u);
  });
});

class FakeTrack implements AudioMediaStreamTrackLike {
  public stopCount = 0;
  public readonly endedListeners = new Set<() => void>();

  public constructor(public readonly readyState: MediaStreamTrackState = "live") {}

  public stop(): void {
    this.stopCount += 1;
  }

  public addEventListener(_type: "ended", listener: () => void): void {
    this.endedListeners.add(listener);
  }

  public removeEventListener(_type: "ended", listener: () => void): void {
    this.endedListeners.delete(listener);
  }

  public emitEnded(): void {
    for (const listener of [...this.endedListeners]) listener();
  }
}

class FakeStream implements AudioMediaStreamLike {
  public constructor(public readonly track: FakeTrack) {}

  public getAudioTracks(): readonly AudioMediaStreamTrackLike[] {
    return [this.track];
  }
}

class FakeMediaDevices implements AudioMediaDevicesLike {
  public readonly deviceChangeListeners = new Set<() => void>();
  public readonly streams: FakeStream[] = [];
  public devices: readonly AudioMediaDeviceInfoLike[] = [];
  public getUserMediaError: Error | undefined;
  public enumerateError: Error | undefined;
  public lastConstraints: MediaStreamConstraints | undefined;

  public async getUserMedia(constraints: MediaStreamConstraints): Promise<AudioMediaStreamLike> {
    this.lastConstraints = constraints;
    if (this.getUserMediaError !== undefined) throw this.getUserMediaError;
    const stream = new FakeStream(new FakeTrack());
    this.streams.push(stream);
    return stream;
  }

  public async enumerateDevices(): Promise<readonly AudioMediaDeviceInfoLike[]> {
    if (this.enumerateError !== undefined) throw this.enumerateError;
    return this.devices;
  }

  public addEventListener(_type: "devicechange", listener: () => void): void {
    this.deviceChangeListeners.add(listener);
  }

  public removeEventListener(_type: "devicechange", listener: () => void): void {
    this.deviceChangeListeners.delete(listener);
  }

  public emitDeviceChange(): void {
    for (const listener of [...this.deviceChangeListeners]) listener();
  }
}

describe("browser audio devices", () => {
  it("represents input/output devices without assuming labels are available", async () => {
    const media = new FakeMediaDevices();
    media.devices = [
      { kind: "audioinput", deviceId: "default", label: "" },
      { kind: "audioinput", deviceId: "mic-2", label: "USB Mic" },
      { kind: "audiooutput", deviceId: "", label: "System Default" },
      { kind: "audiooutput", deviceId: "speaker-1", label: "Speakers" },
      { kind: "videoinput", deviceId: "camera", label: "Camera" }
    ];

    const result = await new BrowserAudioDeviceManager(media).enumerate();
    expect(result.status).toBe("AVAILABLE");
    expect(result.devices).toEqual([
      {
        kind: "INPUT",
        deviceId: "default",
        label: undefined,
        isDefault: true,
        availability: "AVAILABLE"
      },
      {
        kind: "INPUT",
        deviceId: "mic-2",
        label: "USB Mic",
        isDefault: false,
        availability: "AVAILABLE"
      },
      {
        kind: "OUTPUT",
        deviceId: "",
        label: "System Default",
        isDefault: false,
        availability: "AVAILABLE"
      },
      {
        kind: "OUTPUT",
        deviceId: "speaker-1",
        label: "Speakers",
        isDefault: false,
        availability: "AVAILABLE"
      }
    ]);
    expect(unavailableAudioDevice("INPUT", "mic-gone").availability).toBe("UNAVAILABLE");
    expect(unavailableAudioDevice("OUTPUT", "").isDefault).toBe(false);
  });

  it("contains throwing media capability getters inside typed device results", async () => {
    const enumerateFailure = new Error("enumerate getter failed");
    const media = {} as AudioMediaDevicesLike;
    Object.defineProperty(media, "enumerateDevices", {
      get: () => {
        throw enumerateFailure;
      }
    });
    Object.defineProperty(media, "addEventListener", {
      get: () => {
        throw new Error("devicechange getter failed");
      }
    });

    const manager = new BrowserAudioDeviceManager(media);
    expect(await manager.enumerate()).toEqual({
      status: "FAILED",
      devices: [],
      message: "enumerate getter failed"
    });

    try {
      manager.subscribe(() => undefined);
      throw new Error("Expected hostile devicechange getter to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("UNSUPPORTED");
    }
  });

  it("returns a stable FAILED result even when enumeration error formatting is hostile", async () => {
    const hostileError = {};
    Object.defineProperty(hostileError, "message", {
      get: () => {
        throw new Error("message getter failed");
      }
    });
    const manager = new BrowserAudioDeviceManager({
      enumerateDevices: () => Promise.reject(hostileError)
    });

    expect(await manager.enumerate()).toEqual({
      status: "FAILED",
      devices: [],
      message: "Audio device enumeration failed"
    });
  });

  it("ignores non-audio devices without reading irrelevant metadata", async () => {
    let idReads = 0;
    let labelReads = 0;
    const videoDevice = {
      kind: "videoinput",
      get deviceId() {
        idReads += 1;
        throw new Error("video id should not be read");
      },
      get label() {
        labelReads += 1;
        throw new Error("video label should not be read");
      }
    } as unknown as AudioMediaDeviceInfoLike;
    const manager = new BrowserAudioDeviceManager({
      enumerateDevices: async () => [videoDevice]
    });

    expect(await manager.enumerate()).toEqual({
      status: "AVAILABLE",
      devices: []
    });
    expect(idReads).toBe(0);
    expect(labelReads).toBe(0);
  });

  it("snapshots each enumerated device once before classifying it", async () => {
    let kindReads = 0;
    const device = {
      get kind() {
        kindReads += 1;
        return kindReads === 1 ? "audioinput" : "videoinput";
      },
      deviceId: "mic-stable",
      label: "Stable Mic"
    } as AudioMediaDeviceInfoLike;
    const manager = new BrowserAudioDeviceManager({
      enumerateDevices: async () => [device]
    });

    const result = await manager.enumerate();

    expect(kindReads).toBe(1);
    expect(result).toEqual({
      status: "AVAILABLE",
      devices: [{
        kind: "INPUT",
        deviceId: "mic-stable",
        label: "Stable Mic",
        isDefault: false,
        availability: "AVAILABLE"
      }]
    });
  });

  it("returns FAILED for malformed enumeration result shapes instead of silently treating them as empty", async () => {
    const malformedResults: readonly unknown[] = [
      "audioinput",
      { kind: "audioinput" },
      [null],
      ["audioinput"]
    ];

    for (const malformed of malformedResults) {
      const manager = new BrowserAudioDeviceManager({
        enumerateDevices: async () => malformed as never
      });
      const result = await manager.enumerate();
      expect(result.status).toBe("FAILED");
      if (result.status === "FAILED") expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("returns typed permission and enumeration failures", async () => {
    const media = new FakeMediaDevices();
    media.enumerateError = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
    expect((await new BrowserAudioDeviceManager(media).enumerate()).status).toBe("PERMISSION_DENIED");

    media.enumerateError = new Error("enumeration exploded");
    const failed = await new BrowserAudioDeviceManager(media).enumerate();
    expect(failed.status).toBe("FAILED");
    if (failed.status === "FAILED") expect(failed.message).toContain("enumeration exploded");

    expect((await new BrowserAudioDeviceManager(undefined).enumerate()).status).toBe("UNSUPPORTED");
  });

  it("rejects non-callable device observers before browser listener installation", () => {
    const media = new FakeMediaDevices();
    const manager = new BrowserAudioDeviceManager(media);

    expect(() => manager.subscribe(123 as never)).toThrow(/listener must be callable/u);
    expect(media.deviceChangeListeners.size).toBe(0);
  });

  it("subscribes and unsubscribes exactly once", () => {
    const media = new FakeMediaDevices();
    const manager = new BrowserAudioDeviceManager(media);
    const listener = (): void => undefined;
    const unsubscribe = manager.subscribe(listener);

    expect(media.deviceChangeListeners.size).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(media.deviceChangeListeners.size).toBe(0);
  });

  it("contains async device-change observer rejection", async () => {
    const media = new FakeMediaDevices();
    let calls = 0;
    const unsubscribe = new BrowserAudioDeviceManager(media).subscribe(
      asVoidCallback(async () => {
        calls += 1;
        throw new Error("observer rejected");
      })
    );

    media.emitDeviceChange();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(media.deviceChangeListeners.size).toBe(1);
    unsubscribe();
    expect(media.deviceChangeListeners.size).toBe(0);
  });

  it("does not invoke the observer if browser subscription fires synchronously and then fails", () => {
    let observerCalls = 0;
    const media: AudioMediaDevicesLike = {
      addEventListener: (_type, listener) => {
        listener();
        throw new Error("subscription failed after synchronous callback");
      },
      removeEventListener: () => undefined
    };

    expect(() => new BrowserAudioDeviceManager(media).subscribe(() => {
      observerCalls += 1;
    })).toThrow(/subscription failed after synchronous callback/u);

    expect(observerCalls).toBe(0);
  });

  it("makes a leaked device-change wrapper inert if subscription and rollback both fail", () => {
    const listeners = new Set<() => void>();
    let observerCalls = 0;
    const media: AudioMediaDevicesLike = {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
        throw new Error("subscription failed after attach");
      },
      removeEventListener: () => {
        throw new Error("rollback removal failed");
      }
    };

    expect(() => new BrowserAudioDeviceManager(media).subscribe(() => {
      observerCalls += 1;
    })).toThrow(/subscription failed after attach/u);

    expect(listeners.size).toBe(1);
    for (const leakedListener of listeners) leakedListener();
    expect(observerCalls).toBe(0);
  });

  it("rolls back a device-change listener if subscription throws after side effect", () => {
    const listeners = new Set<() => void>();
    const media: AudioMediaDevicesLike = {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
        throw new Error("subscription failed after attach");
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      }
    };

    expect(() => new BrowserAudioDeviceManager(media).subscribe(() => undefined)).toThrow(
      /subscription failed after attach/u
    );
    expect(listeners.size).toBe(0);
  });

  it("prevents recursive device-change unsubscription during browser removal", () => {
    const listeners = new Set<() => void>();
    let removalAttempts = 0;
    const unsubscribeHolder: { current?: () => void } = {};
    const media: AudioMediaDevicesLike = {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        removalAttempts += 1;
        unsubscribeHolder.current?.();
        listeners.delete(listener);
      }
    };

    const unsubscribe = new BrowserAudioDeviceManager(media).subscribe(() => undefined);
    unsubscribeHolder.current = unsubscribe;
    unsubscribe();

    expect(removalAttempts).toBe(1);
    expect(listeners.size).toBe(0);
    unsubscribe();
    expect(removalAttempts).toBe(1);
  });

  it("keeps device-change unsubscription retryable if removal throws", () => {
    const listeners = new Set<() => void>();
    let removalAttempts = 0;
    const media: AudioMediaDevicesLike = {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        removalAttempts += 1;
        if (removalAttempts === 1) throw new Error("transient removal failure");
        listeners.delete(listener);
      }
    };
    const unsubscribe = new BrowserAudioDeviceManager(media).subscribe(() => undefined);

    expect(listeners.size).toBe(1);
    expect(() => unsubscribe()).toThrow(/transient removal failure/u);
    expect(listeners.size).toBe(1);

    unsubscribe();
    unsubscribe();
    expect(listeners.size).toBe(0);
    expect(removalAttempts).toBe(2);
  });

  it("treats malformed media-device method properties as unsupported capabilities", async () => {
    const malformed = {
      getUserMedia: "not-a-function",
      enumerateDevices: 123,
      addEventListener: {},
      removeEventListener: []
    } as unknown as AudioMediaDevicesLike;

    const manager = new BrowserAudioDeviceManager(malformed);
    expect(await manager.enumerate()).toEqual({ status: "UNSUPPORTED", devices: [] });
    try {
      manager.subscribe(() => undefined);
      throw new Error("Expected malformed device-change capability to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("UNSUPPORTED");
    }

    const capture = new BrowserMicrophoneCapture({
      mediaDevices: malformed,
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });
    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "UNSUPPORTED"
    });
  });

  it("reports missing enumeration and device-change capabilities explicitly", async () => {
    const noEnumeration: AudioMediaDevicesLike = {
      getUserMedia: async () => new FakeStream(new FakeTrack())
    };
    expect((await new BrowserAudioDeviceManager(noEnumeration).enumerate()).status).toBe("UNSUPPORTED");

    const noDeviceChange: AudioMediaDevicesLike = {
      enumerateDevices: async () => []
    };
    expect(() => new BrowserAudioDeviceManager(noDeviceChange).subscribe(() => undefined)).toThrow(
      AudioInfrastructureError
    );
  });
});

class FakeNode implements CaptureAudioNodeLike {
  public connectCount = 0;
  public disconnectCount = 0;
  public connectError: Error | undefined;
  public onConnect: (() => void) | undefined;

  public connect(): void {
    this.connectCount += 1;
    this.onConnect?.();
    if (this.connectError !== undefined) throw this.connectError;
  }

  public disconnect(): void {
    this.disconnectCount += 1;
  }
}

class FakeProcessor extends FakeNode implements CaptureScriptProcessorLike {
  private processHandler: ((event: CaptureAudioProcessEventLike) => void) | null = null;
  public onProcessHandlerSet: (() => void) | undefined;

  public get onaudioprocess(): ((event: CaptureAudioProcessEventLike) => void) | null {
    return this.processHandler;
  }

  public set onaudioprocess(handler: ((event: CaptureAudioProcessEventLike) => void) | null) {
    this.processHandler = handler;
    this.onProcessHandlerSet?.();
  }

  public emit(channels: readonly Float32Array[], sampleRate = 16_000): void {
    const inputBuffer: CaptureAudioBufferLike = {
      sampleRate,
      numberOfChannels: channels.length,
      getChannelData: (channel) => {
        const data = channels[channel];
        if (data === undefined) throw new Error("Missing fake channel");
        return data;
      }
    };
    this.processHandler?.({ inputBuffer });
  }
}

class FakeCaptureContext implements CaptureAudioContextLike {
  public readonly sampleRate = 16_000;
  public readonly destination = {};
  public readonly source = new FakeNode();
  public readonly processor = new FakeProcessor();
  public state = "running";
  public closeCount = 0;
  public resumeCount = 0;
  public closeGate: Promise<void> = Promise.resolve();
  public resumeGate: Promise<void> = Promise.resolve();
  public resumeError: unknown;

  public createMediaStreamSource(): CaptureAudioNodeLike {
    return this.source;
  }

  public createScriptProcessor(): CaptureScriptProcessorLike {
    return this.processor;
  }

  public async resume(): Promise<void> {
    this.resumeCount += 1;
    await this.resumeGate;
    if (this.resumeError !== undefined) await Promise.reject(this.resumeError);
    this.state = "running";
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
    this.state = "closed";
    await this.closeGate;
  }
}

describe("microphone capture lifecycle", () => {
  function fixture(): {
    readonly media: FakeMediaDevices;
    readonly contexts: FakeCaptureContext[];
    readonly environment: BrowserMicrophoneCaptureEnvironment;
    setNow(value: number): void;
  } {
    const media = new FakeMediaDevices();
    const contexts: FakeCaptureContext[] = [];
    let now = 100;
    return {
      media,
      contexts,
      environment: {
        mediaDevices: media,
        createAudioContext: () => {
          const context = new FakeCaptureContext();
          contexts.push(context);
          return context;
        },
        now: () => now
      },
      setNow: (value) => {
        now = value;
      }
    };
  }

  it("rejects malformed microphone ids and throwing getUserMedia getters before acquisition", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);

    await expect(capture.start({
      deviceId: 123,
      onFrame: () => undefined
    } as never)).rejects.toThrow(/deviceId must be a string/u);
    await expect(capture.start({
      deviceId: "   ",
      onFrame: () => undefined
    })).rejects.toThrow(/deviceId must not be whitespace-only/u);
    expect(setup.media.streams).toHaveLength(0);
    expect(setup.contexts).toHaveLength(0);
    expect(capture.state).toBe("IDLE");

    const hostileMedia = {} as AudioMediaDevicesLike;
    Object.defineProperty(hostileMedia, "getUserMedia", {
      get: () => {
        throw new Error("getUserMedia getter failed");
      }
    });
    const hostileCapture = new BrowserMicrophoneCapture({
      mediaDevices: hostileMedia,
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });

    await expect(hostileCapture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "UNSUPPORTED"
    });
    expect(hostileCapture.state).toBe("IDLE");
  });

  it("rejects non-callable capture callbacks before hardware acquisition", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);

    await expect(capture.start({
      onFrame: 123
    } as never)).rejects.toThrow(/onFrame callback must be callable/u);
    expect(setup.media.streams).toHaveLength(0);
    expect(setup.contexts).toHaveLength(0);
    expect(capture.state).toBe("IDLE");

    await expect(capture.start({
      onFrame: () => undefined,
      onError: "not callable"
    } as never)).rejects.toThrow(/onError callback must be callable/u);
    expect(setup.media.streams).toHaveLength(0);
    expect(setup.contexts).toHaveLength(0);
    expect(capture.state).toBe("IDLE");
  });

  it("preserves terminal disposal if getUserMedia capability lookup disposes during admission", async () => {
    const media = {} as AudioMediaDevicesLike;
    const contexts: FakeCaptureContext[] = [];
    Object.defineProperty(media, "getUserMedia", {
      get: () => {
        void capture.dispose();
        return async () => new FakeStream(new FakeTrack());
      }
    });
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => {
        const context = new FakeCaptureContext();
        contexts.push(context);
        return context;
      },
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "DISPOSED"
    });

    expect(capture.state).toBe("DISPOSED");
    expect(contexts).toHaveLength(0);
  });

  it("abandons start if getUserMedia capability lookup stops capture reentrantly", async () => {
    const media = {} as AudioMediaDevicesLike;
    const contexts: FakeCaptureContext[] = [];
    let stopping: Promise<void> | undefined;
    Object.defineProperty(media, "getUserMedia", {
      get: () => {
        stopping = capture.stop();
        return async () => new FakeStream(new FakeTrack());
      }
    });
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => {
        const context = new FakeCaptureContext();
        contexts.push(context);
        return context;
      },
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });
    if (stopping === undefined) throw new Error("Reentrant stop was not invoked");
    await stopping;

    expect(capture.state).toBe("STOPPED");
    expect(contexts).toHaveLength(0);
  });

  it("lets terminal disposal dominate a later throwing option getter", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    const options = {
      get deviceId() {
        void capture.dispose();
        return "mic-never";
      },
      get frameSize() {
        throw new Error("later option getter failed");
      },
      onFrame: () => undefined
    } as unknown as MicrophoneCaptureOptions;

    await expect(capture.start(options)).rejects.toMatchObject({ code: "DISPOSED" });

    expect(capture.state).toBe("DISPOSED");
    expect(setup.media.streams).toHaveLength(0);
    expect(setup.contexts).toHaveLength(0);
  });

  it("lets a reentrant stop dominate a later throwing restart option getter", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    await capture.start({ onFrame: () => undefined });

    let stopping: Promise<void> | undefined;
    const options = {
      get deviceId() {
        stopping = capture.stop();
        return "mic-never";
      },
      get frameSize() {
        throw new Error("later restart option getter failed");
      },
      onFrame: () => undefined
    } as unknown as MicrophoneCaptureOptions;

    await capture.restart(options);
    if (stopping === undefined) throw new Error("Reentrant stop was not invoked");
    await stopping;

    expect(capture.state).toBe("STOPPED");
    expect(setup.media.streams).toHaveLength(1);
    expect(setup.contexts).toHaveLength(1);
  });

  it("preserves terminal disposal if an option getter disposes during start admission", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    const options = {
      get deviceId() {
        void capture.dispose();
        return "mic-never";
      },
      onFrame: () => undefined
    } as MicrophoneCaptureOptions;

    await expect(capture.start(options)).rejects.toMatchObject({ code: "DISPOSED" });

    expect(capture.state).toBe("DISPOSED");
    expect(setup.media.streams).toHaveLength(0);
    expect(setup.contexts).toHaveLength(0);
  });

  it("does not restart capture when an option getter stops it during start admission", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    await capture.start({ onFrame: () => undefined });

    let stopping: Promise<void> | undefined;
    const options = {
      get deviceId() {
        stopping = capture.stop();
        return "mic-never";
      },
      onFrame: () => undefined
    } as MicrophoneCaptureOptions;

    await capture.start(options);
    if (stopping === undefined) throw new Error("Reentrant stop was not invoked");
    await stopping;

    expect(capture.state).toBe("STOPPED");
    expect(setup.media.streams).toHaveLength(1);
    expect(setup.contexts).toHaveLength(1);
    expect(setup.media.streams[0]?.track.stopCount).toBe(1);
  });

  it("still validates malformed start options while capture is already active", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    await capture.start({ onFrame: () => undefined });
    expect(capture.state).toBe("CAPTURING");
    expect(setup.media.streams).toHaveLength(1);

    await expect(capture.start({ onFrame: 123 } as never))
      .rejects.toThrow(/onFrame callback must be callable/u);
    await expect(capture.start({ channelCount: 99, onFrame: () => undefined }))
      .rejects.toThrow(/channel count/u);
    await expect(capture.start({ frameSize: 300, onFrame: () => undefined }))
      .rejects.toThrow(/frame size/u);

    expect(capture.state).toBe("CAPTURING");
    expect(setup.media.streams).toHaveLength(1);
    await capture.dispose();
  });

  it("abandons restart if option getters change capture lifecycle before teardown", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    await capture.start({ onFrame: () => undefined });

    let stopping: Promise<void> | undefined;
    const options = {
      get deviceId() {
        stopping = capture.stop();
        return "mic-never";
      },
      onFrame: () => undefined
    } as MicrophoneCaptureOptions;

    await capture.restart(options);
    if (stopping === undefined) throw new Error("Reentrant stop was not invoked");
    await stopping;

    expect(capture.state).toBe("STOPPED");
    expect(setup.media.streams).toHaveLength(1);
    expect(setup.contexts).toHaveLength(1);
  });

  it("rejects invalid restart options without stopping a healthy active capture", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    await capture.start({ onFrame: () => undefined });

    const stream = setup.media.streams[0];
    const context = setup.contexts[0];
    await expect(capture.restart({ onFrame: 123 } as never))
      .rejects.toThrow(/onFrame callback must be callable/u);

    expect(capture.state).toBe("CAPTURING");
    expect(stream?.track.stopCount).toBe(0);
    expect(context?.closeCount).toBe(0);

    await capture.dispose();
  });

  it("does not let an earlier restart resurrect capture after a later stop", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    await capture.start({ onFrame: () => undefined });

    const firstContext = setup.contexts[0];
    if (firstContext === undefined) throw new Error("Initial capture context was not created");
    let releaseClose: (() => void) | undefined;
    firstContext.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const restarting = capture.restart({ onFrame: () => undefined });
    await Promise.resolve();
    await Promise.resolve();

    expect(capture.state).toBe("STOPPED");
    expect(firstContext.closeCount).toBe(1);

    const laterStop = capture.stop();

    if (releaseClose === undefined) throw new Error("Deferred close resolver was not installed");
    releaseClose();
    await Promise.all([restarting, laterStop]);

    expect(capture.state).toBe("STOPPED");
    expect(setup.media.streams).toHaveLength(1);
    expect(setup.contexts).toHaveLength(1);
    expect(setup.media.streams[0]?.track.stopCount).toBe(1);
  });

  it("snapshots restart options before waiting for active capture cleanup", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    await capture.start({ onFrame: () => undefined });

    const firstContext = setup.contexts[0];
    if (firstContext === undefined) throw new Error("Initial capture context was not created");
    let releaseClose: (() => void) | undefined;
    firstContext.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    let originalFrames = 0;
    let mutatedFrames = 0;
    const options = {
      deviceId: "mic-before",
      onFrame: () => {
        originalFrames += 1;
      }
    };

    const restarting = capture.restart(options);
    await Promise.resolve();
    await Promise.resolve();
    expect(firstContext.closeCount).toBe(1);

    options.deviceId = "mic-after";
    options.onFrame = () => {
      mutatedFrames += 1;
    };

    if (releaseClose === undefined) throw new Error("Deferred close resolver was not installed");
    releaseClose();
    await restarting;

    expect(setup.media.lastConstraints).toEqual({
      audio: { channelCount: 1, deviceId: { exact: "mic-before" } },
      video: false
    });

    const restartedContext = setup.contexts[1];
    if (restartedContext === undefined) throw new Error("Restarted capture context was not created");
    restartedContext.processor.emit([new Float32Array([0.25])]);
    expect(originalFrames).toBe(1);
    expect(mutatedFrames).toBe(0);

    await capture.dispose();
  });

  it("starts, emits normalized copied PCM frames, stops, and restarts without leaks", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    const frames: AudioFrame[] = [];

    expect(capture.state).toBe("IDLE");
    await capture.start({
      deviceId: "mic-2",
      channelCount: 2,
      frameSize: 512,
      onFrame: (audioFrame) => frames.push(audioFrame)
    });
    expect(capture.state).toBe("CAPTURING");
    expect(setup.media.lastConstraints).toEqual({
      audio: { channelCount: 2, deviceId: { exact: "mic-2" } },
      video: false
    });

    setup.setNow(125);
    setup.contexts[0]?.processor.emit([
      new Float32Array([0.25, 0.5]),
      new Float32Array([-0.25, -0.5])
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      sequence: 0,
      sampleRate: 16_000,
      channelCount: 2,
      capturedAtMs: 125,
      offsetMs: 25
    });
    expect(Array.from(frames[0]?.samples ?? [])).toEqual([0.25, -0.25, 0.5, -0.5]);

    const firstStream = setup.media.streams[0];
    const firstContext = setup.contexts[0];
    await capture.stop();
    await capture.stop();
    expect(capture.state).toBe("STOPPED");
    expect(firstStream?.track.stopCount).toBe(1);
    expect(firstStream?.track.endedListeners.size).toBe(0);
    expect(firstContext?.source.disconnectCount).toBe(1);
    expect(firstContext?.processor.disconnectCount).toBe(1);
    expect(firstContext?.closeCount).toBe(1);

    setup.setNow(200);
    await capture.restart({ onFrame: (audioFrame) => frames.push(audioFrame) });
    expect(capture.state).toBe("CAPTURING");
    expect(setup.media.streams).toHaveLength(2);
    expect(setup.media.streams[1]?.track.endedListeners.size).toBe(1);

    await capture.dispose();
    await capture.dispose();
    expect(capture.state).toBe("DISPOSED");
    expect(setup.media.streams[1]?.track.stopCount).toBe(1);
    expect(setup.media.streams[1]?.track.endedListeners.size).toBe(0);
    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({ code: "DISPOSED" });
  });

  it("does not overwrite disposal triggered during hostile capture error classification", async () => {
    const hostileError = {};
    Object.defineProperty(hostileError, "name", {
      get: () => {
        void capture.dispose();
        return "AbortError";
      }
    });
    const media: AudioMediaDevicesLike = {
      getUserMedia: () => Promise.reject(hostileError)
    };
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });

    expect(capture.state).toBe("DISPOSED");
    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "DISPOSED"
    });
  });

  it("does not overwrite stop triggered during hostile capture error classification", async () => {
    let stopping: Promise<void> | undefined;
    const hostileError = {};
    Object.defineProperty(hostileError, "name", {
      get: () => {
        stopping = capture.stop();
        return "AbortError";
      }
    });
    const media: AudioMediaDevicesLike = {
      getUserMedia: () => Promise.reject(hostileError)
    };
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });
    if (stopping === undefined) throw new Error("Reentrant stop was not invoked");
    await stopping;

    expect(capture.state).toBe("STOPPED");
  });

  it("keeps capture recoverable when a thrown value has a hostile name accessor", async () => {
    const hostileError = {};
    Object.defineProperty(hostileError, "name", {
      get: () => {
        throw new Error("name getter failed");
      }
    });
    const media: AudioMediaDevicesLike = {
      getUserMedia: () => Promise.reject(hostileError)
    };
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "CAPTURE_FAILED"
    });
    expect(capture.state).toBe("FAILED");

    await capture.stop();
    expect(capture.state).toBe("STOPPED");
  });

  it("maps permission denial and device disappearance to typed failures", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    setup.media.getUserMediaError = Object.assign(new Error("denied"), { name: "NotAllowedError" });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "PERMISSION_DENIED"
    });
    expect(capture.state).toBe("FAILED");

    setup.media.getUserMediaError = undefined;
    const errors: AudioInfrastructureError[] = [];
    await capture.restart({
      onFrame: () => undefined,
      onError: (error) => errors.push(error)
    });
    const activeTrack = setup.media.streams.at(-1)?.track;
    activeTrack?.emitEnded();
    await Promise.resolve();
    await Promise.resolve();

    expect(capture.state).toBe("FAILED");
    expect(errors.at(-1)?.code).toBe("DEVICE_UNAVAILABLE");
    expect(activeTrack?.stopCount).toBe(1);
    expect(activeTrack?.endedListeners.size).toBe(0);
  });

  it("snapshots the AudioContext sample rate once for the capture cycle", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    let sampleRateReads = 0;
    Object.defineProperty(context, "sampleRate", {
      get: () => {
        sampleRateReads += 1;
        return sampleRateReads === 1 ? 16_000 : 48_000;
      }
    });
    const frames: AudioFrame[] = [];
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });

    await capture.start({ onFrame: (frame) => frames.push(frame) });
    context.processor.emit([new Float32Array([0.25])], 16_000);

    expect(sampleRateReads).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.sampleRate).toBe(16_000);
    await capture.dispose();
  });

  it("does not resume a context after sample-rate lookup reentrantly stops capture", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    context.state = "suspended";
    let stopping: Promise<void> | undefined;
    Object.defineProperty(context, "sampleRate", {
      get: () => {
        stopping = capture.stop();
        return 16_000;
      }
    });
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });
    if (stopping === undefined) throw new Error("Reentrant stop was not invoked");
    await stopping;

    expect(capture.state).toBe("STOPPED");
    expect(context.resumeCount).toBe(0);
    expect(context.source.connectCount).toBe(0);
    expect(context.closeCount).toBe(1);
    expect(media.streams[0]?.track.stopCount).toBe(1);
  });

  it("does not invoke resume if its getter disposes capture reentrantly", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    context.state = "suspended";
    let resumeCalls = 0;
    Object.defineProperty(context, "resume", {
      get: () => {
        void capture.dispose();
        return async () => {
          resumeCalls += 1;
        };
      }
    });
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });

    expect(capture.state).toBe("DISPOSED");
    expect(resumeCalls).toBe(0);
    expect(context.source.connectCount).toBe(0);
    expect(context.closeCount).toBe(1);
    expect(media.streams[0]?.track.stopCount).toBe(1);
  });

  it("resumes a suspended Web Audio context before declaring capture active", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    context.state = "suspended";
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });

    expect(context.resumeCount).toBe(1);
    expect(context.state).toBe("running");
    expect(context.source.connectCount).toBe(1);
    expect(capture.state).toBe("CAPTURING");
    await capture.dispose();
  });

  it("maps a denied AudioContext resume to a typed capture permission failure", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    context.state = "suspended";
    context.resumeError = Object.assign(new Error("resume blocked"), { name: "NotAllowedError" });
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "PERMISSION_DENIED"
    });
    expect(capture.state).toBe("FAILED");
    expect(context.resumeCount).toBe(1);
    expect(context.source.connectCount).toBe(0);
    expect(context.closeCount).toBe(1);
    expect(media.streams[0]?.track.stopCount).toBe(1);
  });

  it("cancels a pending AudioContext resume without waiting for it to settle", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    context.state = "suspended";
    let releaseResume: (() => void) | undefined;
    context.resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });

    const starting = capture.start({ onFrame: () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    expect(context.resumeCount).toBe(1);

    await capture.stop();
    expect(capture.state).toBe("STOPPED");
    expect(context.source.connectCount).toBe(0);
    expect(context.closeCount).toBe(1);
    expect(media.streams[0]?.track.stopCount).toBe(1);

    if (releaseResume === undefined) throw new Error("Resume resolver was not installed");
    releaseResume();
    await starting;
    expect(capture.state).toBe("STOPPED");
    expect(context.source.connectCount).toBe(0);
  });

  it("rejects if the track ends reentrantly while the audio-process handler is installed", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });
    context.processor.onProcessHandlerSet = () => {
      if (context.processor.onaudioprocess !== null) {
        media.streams[0]?.track.emitEnded();
      }
    };

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "DEVICE_UNAVAILABLE"
    });

    expect(capture.state).toBe("FAILED");
    expect(media.streams[0]?.track.stopCount).toBe(1);
    expect(media.streams[0]?.track.endedListeners.size).toBe(0);
    expect(context.processor.onaudioprocess).toBeNull();
    expect(context.closeCount).toBe(1);
  });

  it("contains rejection from an async onError observer without changing capture failure", async () => {
    const media = new FakeMediaDevices();
    media.getUserMediaError = Object.assign(new Error("permission denied"), {
      name: "NotAllowedError"
    });
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });

    await expect(capture.start({
      onFrame: () => undefined,
      onError: asVoidCallback(async () => {
        throw new Error("observer rejected");
      })
    })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    await Promise.resolve();
    await Promise.resolve();
    expect(capture.state).toBe("FAILED");
  });

  it("rejects when the track ends synchronously while its ended listener is being installed", async () => {
    let stopCount = 0;
    const listeners = new Set<() => void>();
    const track: AudioMediaStreamTrackLike = {
      readyState: "live",
      stop: () => {
        stopCount += 1;
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener);
        listener();
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      }
    };
    const context = new FakeCaptureContext();
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: {
        getUserMedia: async () => ({
          getAudioTracks: () => [track]
        })
      },
      createAudioContext: () => context,
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "DEVICE_UNAVAILABLE"
    });

    expect(capture.state).toBe("FAILED");
    expect(stopCount).toBe(1);
    expect(listeners.size).toBe(0);
    expect(context.source.connectCount).toBe(0);
    expect(context.closeCount).toBe(1);
  });

  it("rejects non-finite capture clock values instead of emitting invalid frame metadata", async () => {
    const setup = fixture();
    setup.setNow(Number.NaN);
    const capture = new BrowserMicrophoneCapture(setup.environment);

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "CAPTURE_FAILED"
    });
    expect(capture.state).toBe("FAILED");
    expect(setup.media.streams[0]?.track.stopCount).toBe(1);
    expect(setup.contexts[0]?.closeCount).toBe(1);
  });

  it("does not invoke a clock function returned after its getter stops capture", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    const frames: AudioFrame[] = [];
    let stopping: Promise<void> | undefined;
    let clockGetterReads = 0;
    let clockCalls = 0;
    const environment = {
      mediaDevices: media,
      createAudioContext: () => context,
      get now() {
        clockGetterReads += 1;
        if (clockGetterReads > 1) stopping = capture.stop();
        return () => {
          clockCalls += 1;
          return clockCalls * 10;
        };
      }
    } satisfies BrowserMicrophoneCaptureEnvironment;
    const capture = new BrowserMicrophoneCapture(environment);

    await capture.start({ onFrame: (frame) => frames.push(frame) });
    context.processor.emit([new Float32Array([0.25])]);

    if (stopping === undefined) throw new Error("Reentrant stop was not invoked");
    await stopping;
    await Promise.resolve();

    expect(capture.state).toBe("STOPPED");
    expect(frames).toHaveLength(0);
    expect(clockGetterReads).toBe(2);
    expect(clockCalls).toBe(1);
  });

  it("does not deliver a frame if the capture clock reentrantly stops capture", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    const frames: AudioFrame[] = [];
    let stopping: Promise<void> | undefined;
    let clockReads = 0;
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => {
        clockReads += 1;
        if (clockReads > 1) stopping = capture.stop();
        return clockReads * 10;
      }
    });

    await capture.start({ onFrame: (frame) => frames.push(frame) });
    context.processor.emit([new Float32Array([0.25])]);

    if (stopping === undefined) throw new Error("Reentrant stop was not invoked");
    await stopping;
    await Promise.resolve();

    expect(capture.state).toBe("STOPPED");
    expect(frames).toHaveLength(0);
    expect(media.streams[0]?.track.stopCount).toBe(1);
  });

  it("fails an active capture if its clock moves backwards", async () => {
    const setup = fixture();
    const errors: AudioInfrastructureError[] = [];
    const frames: AudioFrame[] = [];
    const capture = new BrowserMicrophoneCapture(setup.environment);
    await capture.start({
      onFrame: (audioFrame) => frames.push(audioFrame),
      onError: (error) => errors.push(error)
    });

    setup.setNow(125);
    setup.contexts[0]?.processor.emit([new Float32Array([0.25])]);
    expect(frames).toHaveLength(1);

    setup.setNow(124);
    setup.contexts[0]?.processor.emit([new Float32Array([0.5])]);
    await Promise.resolve();
    await Promise.resolve();

    expect(capture.state).toBe("FAILED");
    expect(frames).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("CAPTURE_FAILED");
    expect(setup.media.streams[0]?.track.stopCount).toBe(1);
  });

  it("fails an active capture if its clock later becomes non-finite", async () => {
    const setup = fixture();
    const errors: AudioInfrastructureError[] = [];
    const capture = new BrowserMicrophoneCapture(setup.environment);
    await capture.start({
      onFrame: () => undefined,
      onError: (error) => errors.push(error)
    });

    setup.setNow(Number.POSITIVE_INFINITY);
    setup.contexts[0]?.processor.emit([new Float32Array([0.25])]);
    await Promise.resolve();
    await Promise.resolve();

    expect(capture.state).toBe("FAILED");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("CAPTURE_FAILED");
    expect(setup.media.streams[0]?.track.stopCount).toBe(1);
  });

  it("still stops accessible tracks when one proxied track slot throws during materialization", async () => {
    const first = new FakeTrack();
    const hidden = new FakeTrack();
    const later = new FakeTrack();
    const target = [first, hidden, later];
    const hostileTracks = new Proxy(target, {
      get(array, property, receiver) {
        if (property === "1") throw new Error("track slot unavailable");
        return proxyGet(array, property, receiver);
      }
    });
    const stream: AudioMediaStreamLike = {
      getAudioTracks: () => hostileTracks
    };
    const contextCreations: FakeCaptureContext[] = [];
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: { getUserMedia: async () => stream },
      createAudioContext: () => {
        const context = new FakeCaptureContext();
        contextCreations.push(context);
        return context;
      },
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "CAPTURE_FAILED"
    });

    expect(first.stopCount).toBe(1);
    expect(hidden.stopCount).toBe(0);
    expect(later.stopCount).toBe(1);
    expect(contextCreations).toHaveLength(0);
    expect(capture.state).toBe("FAILED");
  });

  it("rejects malformed microphone track readyState values before Web Audio setup", async () => {
    const track = new FakeTrack("invalid-state" as MediaStreamTrackState);
    const context = new FakeCaptureContext();
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: {
        getUserMedia: async () => new FakeStream(track)
      },
      createAudioContext: () => context,
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "CAPTURE_FAILED"
    });

    expect(capture.state).toBe("FAILED");
    expect(track.stopCount).toBe(1);
    expect(context.source.connectCount).toBe(0);
    expect(context.closeCount).toBe(0);
  });

  it("rejects a stream whose audio track already ended before setup", async () => {
    const endedTrack = new FakeTrack("ended");
    const media: AudioMediaDevicesLike = {
      getUserMedia: async () => new FakeStream(endedTrack)
    };
    let contextCreations = 0;
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => {
        contextCreations += 1;
        return new FakeCaptureContext();
      },
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "DEVICE_UNAVAILABLE"
    });

    expect(capture.state).toBe("FAILED");
    expect(endedTrack.stopCount).toBe(1);
    expect(endedTrack.endedListeners.size).toBe(0);
    expect(contextCreations).toBe(0);
  });

  it("fails capture once when an async frame consumer rejects", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    const errors: AudioInfrastructureError[] = [];
    await capture.start({
      onFrame: asVoidCallback(async () => {
        throw new Error("async consumer failed");
      }),
      onError: (error) => errors.push(error)
    });

    setup.contexts[0]?.processor.emit([new Float32Array([0.25])]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(capture.state).toBe("FAILED");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("CAPTURE_FAILED");
    expect(setup.media.streams[0]?.track.stopCount).toBe(1);
    expect(setup.contexts[0]?.closeCount).toBe(1);
  });

  it("does not inspect a buffer returned after inputBuffer acquisition stops capture", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    let sampleRateReads = 0;
    await capture.start({ onFrame: () => undefined });

    const processor = setup.contexts[0]?.processor;
    if (processor === undefined || processor.onaudioprocess === null) {
      throw new Error("Capture processor was not installed");
    }

    const inputBuffer: CaptureAudioBufferLike = {
      get sampleRate() {
        sampleRateReads += 1;
        return 16_000;
      },
      numberOfChannels: 1,
      getChannelData: () => new Float32Array([0.25])
    };
    const event: CaptureAudioProcessEventLike = {
      get inputBuffer() {
        void capture.stop();
        return inputBuffer;
      }
    };

    processor.onaudioprocess(event);
    await Promise.resolve();
    await Promise.resolve();

    expect(capture.state).toBe("STOPPED");
    expect(sampleRateReads).toBe(0);
    expect(setup.media.streams[0]?.track.stopCount).toBe(1);
  });

  it("fails capture once when a frame consumer throws instead of continuing an error loop", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    const errors: AudioInfrastructureError[] = [];
    await capture.start({
      onFrame: () => {
        throw new Error("consumer failed");
      },
      onError: (error) => errors.push(error)
    });

    const processor = setup.contexts[0]?.processor;
    processor?.emit([new Float32Array([0.25])]);
    processor?.emit([new Float32Array([0.5])]);
    await Promise.resolve();
    await Promise.resolve();

    expect(capture.state).toBe("FAILED");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("CAPTURE_FAILED");
    expect(setup.media.streams[0]?.track.stopCount).toBe(1);
    expect(setup.media.streams[0]?.track.endedListeners.size).toBe(0);
    expect(setup.contexts[0]?.closeCount).toBe(1);
  });

  it("rejects malformed browser audio buffers instead of padding or emitting invalid frames", async () => {
    const malformedCases: readonly ((processor: FakeProcessor) => void)[] = [
      (processor) => processor.emit([]),
      (processor) => processor.emit([new Float32Array([0.1])], Number.NaN),
      (processor) => processor.emit([new Float32Array([0.1])], 48_000),
      (processor) => processor.emit([new Float32Array(2_049)]),
      (processor) => processor.emit([
        new Float32Array([0.1]),
        new Float32Array([0.2])
      ]),
      (processor) => processor.emit([new Float32Array([Number.NaN])]),
      (processor) => processor.emit([new Float32Array([Number.POSITIVE_INFINITY])]),
      (processor) => processor.onaudioprocess?.({
        inputBuffer: {
          sampleRate: 16_000,
          numberOfChannels: 1,
          getChannelData: () => [0.1, 0.2] as unknown as Float32Array
        }
      }),
      (processor) => processor.emit([
        new Float32Array([0.1, 0.2]),
        new Float32Array([0.3])
      ])
    ];

    for (const emitMalformed of malformedCases) {
      const setup = fixture();
      const errors: AudioInfrastructureError[] = [];
      const frames: AudioFrame[] = [];
      const capture = new BrowserMicrophoneCapture(setup.environment);
      await capture.start({
        onFrame: (audioFrame) => frames.push(audioFrame),
        onError: (error) => errors.push(error)
      });

      const processor = setup.contexts[0]?.processor;
      if (processor === undefined) throw new Error("Capture processor was not created");
      emitMalformed(processor);
      await Promise.resolve();
      await Promise.resolve();

      expect(capture.state).toBe("FAILED");
      expect(frames).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("CAPTURE_FAILED");
      expect(setup.media.streams[0]?.track.stopCount).toBe(1);
      expect(setup.contexts[0]?.closeCount).toBe(1);
    }
  });

  it("still disconnects nodes and closes context when the track collection becomes non-iterable during cleanup", async () => {
    const track = new FakeTrack();
    const malformedTracks = {
      length: 1,
      some: () => false,
      0: track
    } as unknown as readonly AudioMediaStreamTrackLike[];
    const context = new FakeCaptureContext();
    const media: AudioMediaDevicesLike = {
      getUserMedia: async () => ({
        getAudioTracks: () => malformedTracks
      })
    };
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "CAPTURE_FAILED"
    });

    expect(capture.state).toBe("FAILED");
    expect(context.source.disconnectCount).toBe(1);
    expect(context.processor.connectCount).toBe(0);
    expect(context.processor.disconnectCount).toBe(1);
    expect(context.closeCount).toBe(1);
  });

  it("does not let a malformed cleanup value poison later capture lifecycle", async () => {
    let malformed = true;
    const media: AudioMediaDevicesLike = {
      getUserMedia: async () => ({
        getAudioTracks: () => malformed
          ? null as unknown as readonly AudioMediaStreamTrackLike[]
          : [new FakeTrack()]
      })
    };
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "CAPTURE_FAILED"
    });
    expect(capture.state).toBe("FAILED");

    malformed = false;
    await capture.restart({ onFrame: () => undefined });
    expect(capture.state).toBe("CAPTURING");
    await capture.dispose();
  });

  it("rejects malformed Web Audio source nodes before creating a processor", async () => {
    const track = new FakeTrack();
    let processorCreations = 0;
    let closeCount = 0;
    const context = {
      sampleRate: 16_000,
      destination: {},
      state: "running",
      createMediaStreamSource: () => ({}) as CaptureAudioNodeLike,
      createScriptProcessor: () => {
        processorCreations += 1;
        return new FakeProcessor();
      },
      close: async () => {
        closeCount += 1;
      }
    } as CaptureAudioContextLike;
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: {
        getUserMedia: async () => new FakeStream(track)
      },
      createAudioContext: () => context,
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "CAPTURE_FAILED"
    });

    expect(processorCreations).toBe(0);
    expect(track.stopCount).toBe(1);
    expect(closeCount).toBe(1);
  });

  it("cleans partially created capture resources when Web Audio setup fails", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    context.source.connectError = new Error("source connect failed");
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "CAPTURE_FAILED"
    });

    const track = media.streams[0]?.track;
    expect(capture.state).toBe("FAILED");
    expect(track?.stopCount).toBe(1);
    expect(track?.endedListeners.size).toBe(0);
    expect(context.source.disconnectCount).toBe(1);
    expect(context.processor.disconnectCount).toBe(1);
    expect(context.closeCount).toBe(1);
  });

  it("treats empty and Chromium default input ids as default-device selection", async () => {
    for (const deviceId of ["", "default"] as const) {
      const setup = fixture();
      const capture = new BrowserMicrophoneCapture(setup.environment);

      await capture.start({
        deviceId,
        onFrame: () => undefined
      });

      expect(setup.media.lastConstraints).toEqual({
        audio: { channelCount: 1 },
        video: false
      });
      await capture.dispose();
    }
  });

  it("rejects invalid ScriptProcessor frame sizes and channel counts before requesting hardware", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);

    await expect(capture.start({ frameSize: 300, onFrame: () => undefined })).rejects.toThrow(
      /frame size/u
    );
    await expect(capture.start({ frameSize: 32_768, onFrame: () => undefined })).rejects.toThrow(
      /frame size/u
    );
    await expect(capture.start({ channelCount: 0, onFrame: () => undefined })).rejects.toThrow(
      /channel count/u
    );
    await expect(capture.start({ channelCount: 33, onFrame: () => undefined })).rejects.toThrow(
      /channel count/u
    );

    expect(setup.media.streams).toHaveLength(0);
    expect(capture.state).toBe("IDLE");
  });

  it("cancels a pending permission request without allowing late capture activation", async () => {
    let resolveStream: ((stream: AudioMediaStreamLike) => void) | undefined;
    const track = new FakeTrack();
    const media: AudioMediaDevicesLike = {
      getUserMedia: () => new Promise<AudioMediaStreamLike>((resolve) => {
        resolveStream = resolve;
      })
    };
    let contextCreations = 0;
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => {
        contextCreations += 1;
        return new FakeCaptureContext();
      },
      now: () => 0
    });

    const starting = capture.start({ onFrame: () => undefined });
    let startingResolved = false;
    void starting.then(() => {
      startingResolved = true;
    });
    await Promise.resolve();
    expect(capture.state).toBe("STARTING");

    await capture.stop();
    expect(capture.state).toBe("STOPPED");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(startingResolved).toBe(true);

    if (resolveStream === undefined) throw new Error("Pending getUserMedia resolver was not installed");
    resolveStream(new FakeStream(track));
    await Promise.resolve();
    await Promise.resolve();

    expect(capture.state).toBe("STOPPED");
    expect(track.stopCount).toBe(1);
    expect(contextCreations).toBe(0);
  });

  it("rejects tracks without required lifecycle methods before creating Web Audio", async () => {
    let contextCreations = 0;
    const malformedTrack = {
      readyState: "live",
      stop: () => undefined,
      addEventListener: 123,
      removeEventListener: () => undefined
    } as unknown as AudioMediaStreamTrackLike;
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: {
        getUserMedia: async () => ({
          getAudioTracks: () => [malformedTrack]
        })
      },
      createAudioContext: () => {
        contextCreations += 1;
        return new FakeCaptureContext();
      },
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "CAPTURE_FAILED"
    });

    expect(capture.state).toBe("FAILED");
    expect(contextCreations).toBe(0);
  });

  it("does not reread lifecycle capability getters for duplicate track references", async () => {
    const base = new FakeTrack();
    let stopReads = 0;
    const track = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "stop") {
          stopReads += 1;
          if (stopReads > 1) throw new Error("duplicate track capability was reread");
        }
        return proxyGet(target, property, receiver);
      }
    }) as AudioMediaStreamTrackLike;
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: {
        getUserMedia: async () => ({
          getAudioTracks: () => [track, track]
        })
      },
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });
    expect(stopReads).toBe(1);
    await capture.dispose();
    expect(base.stopCount).toBe(1);
  });

  it("owns duplicate stream track references only once", async () => {
    const track = new FakeTrack();
    const context = new FakeCaptureContext();
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: {
        getUserMedia: async () => ({
          getAudioTracks: () => [track, track]
        })
      },
      createAudioContext: () => context,
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });
    expect(capture.state).toBe("CAPTURING");
    expect(track.endedListeners.size).toBe(1);

    await capture.dispose();

    expect(track.stopCount).toBe(1);
    expect(track.endedListeners.size).toBe(0);
    expect(context.closeCount).toBe(1);
  });

  it("also checks getTracks when getAudioTracks returns an empty cleanup view", async () => {
    let resolveStream: ((stream: AudioMediaStreamLike) => void) | undefined;
    const track = new FakeTrack();
    const media: AudioMediaDevicesLike = {
      getUserMedia: () => new Promise<AudioMediaStreamLike>((resolve) => {
        resolveStream = resolve;
      })
    };
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });

    const starting = capture.start({ onFrame: () => undefined });
    await Promise.resolve();
    await capture.stop();
    await starting;

    if (resolveStream === undefined) throw new Error("Pending getUserMedia resolver was not installed");
    resolveStream({
      getAudioTracks: () => [],
      getTracks: () => [track]
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(track.stopCount).toBe(1);
  });

  it("uses getTracks as late-stream cleanup fallback when getAudioTracks is unusable", async () => {
    let resolveStream: ((stream: AudioMediaStreamLike) => void) | undefined;
    const track = new FakeTrack();
    const media: AudioMediaDevicesLike = {
      getUserMedia: () => new Promise<AudioMediaStreamLike>((resolve) => {
        resolveStream = resolve;
      })
    };
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });

    const starting = capture.start({ onFrame: () => undefined });
    await Promise.resolve();
    await capture.stop();
    await starting;

    if (resolveStream === undefined) throw new Error("Pending getUserMedia resolver was not installed");
    const lateStream = {
      getAudioTracks: () => {
        throw new Error("audio track enumeration failed");
      },
      getTracks: () => [track]
    } as AudioMediaStreamLike;
    resolveStream(lateStream);
    await Promise.resolve();
    await Promise.resolve();

    expect(track.stopCount).toBe(1);
    expect(capture.state).toBe("STOPPED");
  });

  it("cancels a queued replacement start promptly without waiting for an older permission prompt", async () => {
    const firstTrack = new FakeTrack();
    let resolveFirst: ((stream: AudioMediaStreamLike) => void) | undefined;
    let callCount = 0;
    const media: AudioMediaDevicesLike = {
      getUserMedia: () => {
        callCount += 1;
        return new Promise<AudioMediaStreamLike>((resolve) => {
          if (callCount !== 1) throw new Error("Queued replacement should never reach getUserMedia");
          resolveFirst = resolve;
        });
      }
    };
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });

    const firstStart = capture.start({ onFrame: () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    expect(callCount).toBe(1);

    await capture.stop();
    const replacementStart = capture.start({ onFrame: () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    expect(callCount).toBe(1);

    await capture.dispose();
    await replacementStart;
    expect(capture.state).toBe("DISPOSED");
    expect(callCount).toBe(1);

    if (resolveFirst === undefined) throw new Error("First getUserMedia resolver was not installed");
    resolveFirst(new FakeStream(firstTrack));
    await firstStart;
    expect(firstTrack.stopCount).toBe(1);
  });

  it("serializes replacement acquisition behind a superseded permission request", async () => {
    const firstTrack = new FakeTrack();
    const secondTrack = new FakeTrack();
    let callCount = 0;
    let resolveFirst: ((stream: AudioMediaStreamLike) => void) | undefined;
    let resolveSecond: ((stream: AudioMediaStreamLike) => void) | undefined;
    const seenConstraints: MediaStreamConstraints[] = [];
    const media: AudioMediaDevicesLike = {
      getUserMedia: (constraints) => {
        seenConstraints.push(constraints);
        callCount += 1;
        return new Promise<AudioMediaStreamLike>((resolve, reject) => {
          if (callCount === 1) {
            resolveFirst = resolve;
            return;
          }
          if (callCount === 2) {
            resolveSecond = resolve;
            return;
          }
          reject(new Error("Unexpected extra getUserMedia call"));
        });
      }
    };
    const contexts: FakeCaptureContext[] = [];
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => {
        const context = new FakeCaptureContext();
        contexts.push(context);
        return context;
      },
      now: () => 0
    });

    const firstStart = capture.start({ onFrame: () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    expect(callCount).toBe(1);

    await capture.stop();
    const replacementOptions = {
      deviceId: "mic-original",
      onFrame: () => undefined
    };
    const replacementStart = capture.start(replacementOptions);
    replacementOptions.deviceId = "mic-mutated";
    await Promise.resolve();
    await Promise.resolve();
    expect(callCount).toBe(1);

    if (resolveFirst === undefined) throw new Error("First getUserMedia resolver was not installed");
    resolveFirst(new FakeStream(firstTrack));
    await firstStart;
    await Promise.resolve();
    await Promise.resolve();

    expect(firstTrack.stopCount).toBe(1);
    expect(callCount).toBe(2);
    expect(contexts).toHaveLength(0);
    expect(seenConstraints[1]).toEqual({
      audio: { channelCount: 1, deviceId: { exact: "mic-original" } },
      video: false
    });

    if (resolveSecond === undefined) throw new Error("Replacement getUserMedia resolver was not installed");
    resolveSecond(new FakeStream(secondTrack));
    await replacementStart;

    expect(capture.state).toBe("CAPTURING");
    expect(contexts).toHaveLength(1);
    await capture.dispose();
    expect(secondTrack.stopCount).toBe(1);
  });

  it("owns the captured track list so later mutation cannot hide tracks from cleanup", async () => {
    const track = new FakeTrack();
    const mutableTracks: AudioMediaStreamTrackLike[] = [track];
    const stream: AudioMediaStreamLike = {
      getAudioTracks: () => mutableTracks
    };
    const context = new FakeCaptureContext();
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: {
        getUserMedia: async () => stream
      },
      createAudioContext: () => context,
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });
    mutableTracks.length = 0;
    await capture.stop();

    expect(track.stopCount).toBe(1);
    expect(track.endedListeners.size).toBe(0);
    expect(context.closeCount).toBe(1);
  });

  it("registers cleanup before browser teardown can reentrantly start replacement capture", async () => {
    const setup = fixture();
    const capture = new BrowserMicrophoneCapture(setup.environment);
    await capture.start({ onFrame: () => undefined });

    const firstContext = setup.contexts[0];
    const firstTrack = setup.media.streams[0]?.track;
    if (firstContext === undefined || firstTrack === undefined) {
      throw new Error("Initial capture resources were not created");
    }

    let releaseClose: (() => void) | undefined;
    firstContext.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const originalStop = firstTrack.stop.bind(firstTrack);
    let replacementStart: Promise<void> | undefined;
    firstTrack.stop = () => {
      originalStop();
      if (replacementStart === undefined) {
        replacementStart = capture.start({ onFrame: () => undefined });
      }
    };

    const stopping = capture.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(firstContext.closeCount).toBe(1);
    expect(setup.media.streams).toHaveLength(1);

    if (releaseClose === undefined) throw new Error("Deferred close resolver was not installed");
    releaseClose();
    await stopping;
    if (replacementStart === undefined) throw new Error("Reentrant replacement start was not requested");
    await replacementStart;

    expect(setup.media.streams).toHaveLength(2);
    expect(capture.state).toBe("CAPTURING");
    await capture.dispose();
  });

  it("does not let stop resolve while post-permission setup still owns resources", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    let releaseClose: (() => void) | undefined;
    context.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });

    let stopping: Promise<void> | undefined;
    context.source.onConnect = () => {
      stopping = capture.stop();
    };

    const starting = capture.start({ onFrame: () => undefined });
    await Promise.resolve();
    await Promise.resolve();

    expect(capture.state).toBe("STOPPED");
    if (stopping === undefined) throw new Error("Reentrant stop was not invoked");

    let stopResolved = false;
    void stopping.then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(context.closeCount).toBe(1);

    if (releaseClose === undefined) throw new Error("Deferred close resolver was not installed");
    releaseClose();
    await Promise.all([starting, stopping]);

    expect(stopResolved).toBe(true);
    expect(media.streams[0]?.track.stopCount).toBe(1);
    expect(media.streams[0]?.track.endedListeners.size).toBe(0);
    expect(context.source.disconnectCount).toBe(1);
    expect(context.processor.disconnectCount).toBe(1);
    expect(context.closeCount).toBe(1);
  });

  it("makes stop called after dispose wait for setup cleanup already owned by disposal", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    let releaseClose: (() => void) | undefined;
    context.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });

    let disposing: Promise<void> | undefined;
    context.source.onConnect = () => {
      disposing = capture.dispose();
    };

    const starting = capture.start({ onFrame: () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    expect(capture.state).toBe("DISPOSED");
    if (disposing === undefined) throw new Error("Reentrant dispose was not invoked");

    let stopResolved = false;
    const stopping = capture.stop().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    if (releaseClose === undefined) throw new Error("Deferred close resolver was not installed");
    releaseClose();
    await Promise.all([starting, disposing, stopping]);
    expect(stopResolved).toBe(true);
    expect(context.closeCount).toBe(1);
  });

  it("keeps disposal terminal and waits for cleanup already owned by a concurrent stop", async () => {
    const media = new FakeMediaDevices();
    const context = new FakeCaptureContext();
    let releaseClose: (() => void) | undefined;
    context.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: media,
      createAudioContext: () => context,
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });
    const stopping = capture.stop();
    expect(capture.state).toBe("STOPPED");

    let disposalResolved = false;
    const disposing = capture.dispose().then(() => {
      disposalResolved = true;
    });
    expect(capture.state).toBe("DISPOSED");
    await Promise.resolve();
    expect(disposalResolved).toBe(false);

    if (releaseClose === undefined) throw new Error("Deferred close resolver was not installed");
    releaseClose();
    await Promise.all([stopping, disposing]);

    expect(capture.state).toBe("DISPOSED");
    expect(context.closeCount).toBe(1);
    expect(media.streams[0]?.track.stopCount).toBe(1);
    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({ code: "DISPOSED" });
  });

  it("reports unsupported browser media APIs explicitly", async () => {
    const capture = new BrowserMicrophoneCapture({
      mediaDevices: undefined,
      createAudioContext: () => new FakeCaptureContext(),
      now: () => 0
    });

    await expect(capture.start({ onFrame: () => undefined })).rejects.toMatchObject({
      code: "UNSUPPORTED"
    });
  });
});

type FakeAudioEvent = "playing" | "ended" | "error";

class FakeAudioElement implements BrowserAudioElementLike {
  public src = "";
  public preload = "";
  public currentTime = 0;
  public pauseCount = 0;
  public loadCount = 0;
  public playCount = 0;
  public playError: Error | undefined;
  public pauseError: Error | undefined;
  public onPause: (() => void) | undefined;
  public onAddListener: ((type: FakeAudioEvent, listener: () => void) => void) | undefined;
  public removeAttributeError: Error | undefined;
  public sinkError: Error | undefined;
  public sinkGate: Promise<void> | undefined;
  public removeAttributeCount = 0;
  public readonly listeners = new Map<FakeAudioEvent, Set<() => void>>([
    ["playing", new Set()],
    ["ended", new Set()],
    ["error", new Set()]
  ]);
  public sinkIds: string[] = [];
  public sinkSupported = true;

  public async play(): Promise<void> {
    this.playCount += 1;
    if (this.playError !== undefined) throw this.playError;
  }

  public pause(): void {
    this.pauseCount += 1;
    this.onPause?.();
    if (this.pauseError !== undefined) throw this.pauseError;
  }

  public load(): void {
    this.loadCount += 1;
  }

  public addEventListener(type: FakeAudioEvent, listener: () => void): void {
    this.listeners.get(type)?.add(listener);
    this.onAddListener?.(type, listener);
  }

  public removeEventListener(type: FakeAudioEvent, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public removeAttribute(name: string): void {
    this.removeAttributeCount += 1;
    if (this.removeAttributeError !== undefined) throw this.removeAttributeError;
    if (name === "src") this.src = "";
  }

  public async setSinkId(deviceId: string): Promise<void> {
    if (this.sinkGate !== undefined) await this.sinkGate;
    if (!this.sinkSupported) throw new Error("sink unavailable");
    if (this.sinkError !== undefined) throw this.sinkError;
    this.sinkIds.push(deviceId);
  }

  public emit(type: FakeAudioEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  public listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}

describe("default browser audio capabilities", () => {
  it("maps a throwing global Audio getter to typed unsupported playback", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "Audio");
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      get: () => {
        throw new Error("Audio capability getter failed");
      }
    });

    try {
      const playback = new BrowserAudioPlayback();
      const handle = playback.enqueue({ id: "global-audio-getter", source: "/a.wav" });

      expect(await handle.started).toBe(false);
      const outcome = await handle.result;
      expect(outcome.status).toBe("FAILED");
      expect(outcome.error?.code).toBe("UNSUPPORTED");
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "Audio");
      } else {
        Object.defineProperty(globalThis, "Audio", original);
      }
    }
  });

  it("maps a throwing global AudioContext getter to typed unsupported capture capability", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      get: () => {
        throw new Error("AudioContext capability getter failed");
      }
    });

    try {
      const environment = defaultCaptureEnvironment();
      try {
        environment.createAudioContext();
        throw new Error("Expected AudioContext capability lookup to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(AudioInfrastructureError);
        expect((error as AudioInfrastructureError).code).toBe("UNSUPPORTED");
      }
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "AudioContext");
      } else {
        Object.defineProperty(globalThis, "AudioContext", original);
      }
    }
  });

  it("reads the global Audio constructor once before constructing playback", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "Audio");
    let reads = 0;
    let created: FakeAudioElement | undefined;
    const AudioConstructor = function AudioConstructor(): FakeAudioElement {
      created = new FakeAudioElement();
      return created;
    };

    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      get: () => {
        reads += 1;
        if (reads > 1) throw new Error("Audio constructor was reread");
        return AudioConstructor;
      }
    });

    try {
      const playback = new BrowserAudioPlayback();
      const handle = playback.enqueue({ id: "global-audio", source: "/a.wav" });

      expect(reads).toBe(1);
      if (created === undefined) throw new Error("Audio constructor did not run");
      created.emit("playing");
      created.emit("ended");
      expect(await handle.result).toEqual({ id: "global-audio", status: "COMPLETED" });
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "Audio");
      } else {
        Object.defineProperty(globalThis, "Audio", original);
      }
    }
  });

  it("reads the global AudioContext constructor once before constructing capture context", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
    let reads = 0;
    const context = new FakeCaptureContext();
    const AudioContextConstructor = function AudioContextConstructor(): FakeCaptureContext {
      return context;
    };

    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      get: () => {
        reads += 1;
        if (reads > 1) throw new Error("AudioContext constructor was reread");
        return AudioContextConstructor;
      }
    });

    try {
      const environment = defaultCaptureEnvironment();
      expect(environment.createAudioContext()).toBe(context);
      expect(reads).toBe(1);
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "AudioContext");
      } else {
        Object.defineProperty(globalThis, "AudioContext", original);
      }
    }
  });
});

describe("queued browser audio playback", () => {
  function playbackFixture(maxQueueSize = 4): {
    readonly playback: BrowserAudioPlayback;
    readonly elements: FakeAudioElement[];
  } {
    const elements: FakeAudioElement[] = [];
    return {
      elements,
      playback: new BrowserAudioPlayback(() => {
        const element = new FakeAudioElement();
        elements.push(element);
        return element;
      }, maxQueueSize)
    };
  }

  it("does not cancel a unique admission for an unrelated no-op cancellation", () => {
    const setup = playbackFixture();
    const request = {
      get id() {
        setup.playback.cancel("unrelated-id");
        return "outer-id";
      },
      source: "/outer.wav"
    } as PlayableAudio;

    const handle = setup.playback.enqueue(request);

    expect(setup.playback.snapshot()).toEqual({ currentId: "outer-id", queuedIds: [] });
    handle.cancel();
  });

  it("allows an unrelated nested enqueue while preserving queue ordering", () => {
    const setup = playbackFixture();
    let nested: ReturnType<BrowserAudioPlayback["enqueue"]> | undefined;
    const outer = {
      id: "outer-id",
      get source() {
        nested = setup.playback.enqueue({ id: "inner-id", source: "/inner.wav" });
        return "/outer.wav";
      }
    } as PlayableAudio;

    const outerHandle = setup.playback.enqueue(outer);

    expect(setup.playback.snapshot()).toEqual({
      currentId: "inner-id",
      queuedIds: ["outer-id"]
    });

    nested?.cancel();
    outerHandle.cancel();
  });

  it("does not lose cancellation fired by the id getter before reservation exists", () => {
    const setup = playbackFixture();
    const request = {
      get id() {
        setup.playback.cancel("cancel-during-id");
        return "cancel-during-id";
      },
      source: "/a.wav"
    } as PlayableAudio;

    try {
      setup.playback.enqueue(request);
      throw new Error("Expected reentrant id cancellation to invalidate admission");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("CANCELLED");
    }

    expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
    expect(setup.elements).toHaveLength(0);
  });

  it("invalidates identity admission if its getter mutates existing playback history", async () => {
    const setup = playbackFixture();
    const existing = setup.playback.enqueue({
      id: "history-id",
      source: "/existing.wav"
    });
    setup.elements[0]?.emit("playing");

    const hostile = {
      get id() {
        setup.playback.cancel("history-id");
        return "history-id";
      },
      source: "/replacement.wav"
    } as PlayableAudio;

    try {
      setup.playback.enqueue(hostile);
      throw new Error("Expected identity-side playback mutation to invalidate admission");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("CANCELLED");
    }

    expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
    expect(setup.elements).toHaveLength(1);
    await expect(existing.result).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("checks duplicate identity before touching hostile payload getters", () => {
    const setup = playbackFixture();
    const first = setup.playback.enqueue({ id: "same-id", source: "/first.wav" });
    let sourceReads = 0;
    const duplicate = {
      id: "same-id",
      get source() {
        sourceReads += 1;
        throw new Error("duplicate payload should not be read");
      }
    } as unknown as PlayableAudio;

    try {
      setup.playback.enqueue(duplicate);
      throw new Error("Expected duplicate playback identity to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("DUPLICATE_ID");
    }

    expect(sourceReads).toBe(0);
    first.cancel();
  });

  it("reserves playback identity so reentrant same-id admission never becomes live", () => {
    const setup = playbackFixture();
    let innerError: AudioInfrastructureError | undefined;
    const outer = {
      id: "race-id",
      get source() {
        try {
          setup.playback.enqueue({ id: "race-id", source: "/inner.wav" });
        } catch (error) {
          if (error instanceof AudioInfrastructureError) innerError = error;
          throw error;
        }
        return "/outer.wav";
      }
    } as PlayableAudio;

    try {
      setup.playback.enqueue(outer);
      throw new Error("Expected reentrant duplicate admission to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("DUPLICATE_ID");
    }

    expect(innerError?.code).toBe("DUPLICATE_ID");
    expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
    expect(setup.elements).toHaveLength(0);
  });

  it("cancels an in-flight reserved playback id before it reaches the queue", () => {
    const setup = playbackFixture();
    const request = {
      id: "cancel-during-admission",
      get source() {
        setup.playback.cancel("cancel-during-admission");
        return "/never.wav";
      }
    } as PlayableAudio;

    try {
      setup.playback.enqueue(request);
      throw new Error("Expected admission-time cancellation to reject enqueue");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("CANCELLED");
    }

    expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
    expect(setup.elements).toHaveLength(0);

    const later = setup.playback.enqueue({
      id: "cancel-during-admission",
      source: "/later.wav"
    });
    expect(setup.playback.snapshot().currentId).toBe("cancel-during-admission");
    later.cancel();
  });

  it("invalidates an in-flight admission if a payload getter clears queued work", () => {
    const setup = playbackFixture();
    const outer = {
      id: "clear-race",
      get source() {
        setup.playback.clearQueued();
        return "/outer.wav";
      }
    } as PlayableAudio;

    try {
      setup.playback.enqueue(outer);
      throw new Error("Expected cleared in-flight admission to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("CANCELLED");
    }

    expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
    expect(setup.elements).toHaveLength(0);
  });

  it("does not admit a request whose payload getter disposes playback", () => {
    const setup = playbackFixture();
    const outer = {
      id: "dispose-race",
      get source() {
        setup.playback.dispose();
        return "/outer.wav";
      }
    } as PlayableAudio;

    try {
      setup.playback.enqueue(outer);
      throw new Error("Expected disposed in-flight admission to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("DISPOSED");
    }

    expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
    expect(setup.elements).toHaveLength(0);
  });

  it("validates a single owned playback snapshot instead of rereading hostile request getters", () => {
    const setup = playbackFixture();
    let idReads = 0;
    const request = {
      get id() {
        idReads += 1;
        return idReads === 1 ? "stable-id" : "   ";
      },
      source: "/stable.wav"
    } as PlayableAudio;

    const handle = setup.playback.enqueue(request);

    expect(idReads).toBe(1);
    expect(handle.id).toBe("stable-id");
    expect(setup.playback.snapshot().currentId).toBe("stable-id");
    handle.cancel();
  });

  it("rejects malformed playback requests before queue or element ownership", async () => {
    const setup = playbackFixture();

    for (const request of [
      { id: "   ", source: "/a.wav" },
      { id: "a", source: "   " },
      { id: "a", source: "/a.wav", outputDeviceId: "   " },
      { id: "a", source: "/a.wav", callbacks: null },
      { id: "a", source: "/a.wav", callbacks: 123 },
      { id: "a", source: "/a.wav", callbacks: { onStarted: 123 } },
      { id: "a", source: "/a.wav", callbacks: [() => undefined] },
      { id: "a", source: "/a.wav", callbacks: { unexpected: () => undefined } }
    ]) {
      try {
        setup.playback.enqueue(request as never);
        throw new Error("Expected invalid playback request to be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(AudioInfrastructureError);
        expect((error as AudioInfrastructureError).code).toBe("INVALID_REQUEST");
      }
      expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
      expect(setup.elements).toHaveLength(0);
    }
  });

  it("rejects unknown callback keys without invoking their getters", () => {
    const setup = playbackFixture();
    let getterReads = 0;
    const callbacks = {
      get unexpected() {
        getterReads += 1;
        throw new Error("unexpected callback getter should not run");
      }
    };

    try {
      setup.playback.enqueue({
        id: "unknown-callback-key",
        source: "/a.wav",
        callbacks: callbacks as never
      });
      throw new Error("Expected unknown callback key to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("INVALID_REQUEST");
    }

    expect(getterReads).toBe(0);
    expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
    expect(setup.elements).toHaveLength(0);
  });

  it("treats hostile playback request accessors as definite invalid admission", () => {
    const setup = playbackFixture();
    const hostile = {};
    Object.defineProperty(hostile, "id", {
      get: () => {
        throw new Error("id getter failed");
      }
    });

    try {
      setup.playback.enqueue(hostile as never);
      throw new Error("Expected hostile playback request to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("INVALID_REQUEST");
    }
    expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
    expect(setup.elements).toHaveLength(0);
  });

  it("plays queued items in order and fires started before completed", async () => {
    const setup = playbackFixture();
    const order: string[] = [];
    const first = setup.playback.enqueue({
      id: "a",
      source: "/a.wav",
      callbacks: {
        onStarted: () => { order.push("a:start"); },
        onCompleted: () => { order.push("a:complete"); }
      }
    });
    const second = setup.playback.enqueue({
      id: "b",
      source: "/b.wav",
      callbacks: {
        onStarted: () => { order.push("b:start"); },
        onCompleted: () => { order.push("b:complete"); }
      }
    });

    expect(setup.playback.snapshot()).toEqual({ currentId: "a", queuedIds: ["b"] });
    setup.elements[0]?.emit("playing");
    expect(await first.started).toBe(true);
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);

    setup.elements[0]?.emit("ended");
    expect(await first.result).toEqual({ id: "a", status: "COMPLETED" });
    expect(setup.playback.snapshot().currentId).toBe("b");

    setup.elements[1]?.emit("playing");
    expect(await second.started).toBe(true);
    setup.elements[1]?.emit("ended");
    expect(await second.result).toEqual({ id: "b", status: "COMPLETED" });
    expect(order).toEqual(["a:start", "a:complete", "b:start", "b:complete"]);
  });

  it("treats ended-before-playing as failure instead of false completion", async () => {
    const setup = playbackFixture();
    let completed = 0;
    let failed = 0;
    const handle = setup.playback.enqueue({
      id: "ended-before-start",
      source: "/a.wav",
      callbacks: {
        onCompleted: () => { completed += 1; },
        onFailed: () => { failed += 1; }
      }
    });

    setup.elements[0]?.emit("ended");

    expect(await handle.started).toBe(false);
    const outcome = await handle.result;
    expect(outcome.status).toBe("FAILED");
    expect(outcome.error?.code).toBe("PLAYBACK_FAILED");
    await Promise.resolve();
    expect(completed).toBe(0);
    expect(failed).toBe(1);
    expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
  });

  it("cancels queued work before start without a false completion", async () => {
    const setup = playbackFixture();
    let secondCompleted = 0;
    const first = setup.playback.enqueue({ id: "a", source: "/a.wav" });
    const second = setup.playback.enqueue({
      id: "b",
      source: "/b.wav",
      callbacks: { onCompleted: () => { secondCompleted += 1; } }
    });

    second.cancel();
    expect(await second.started).toBe(false);
    expect(await second.result).toEqual({ id: "b", status: "CANCELLED" });
    expect(secondCompleted).toBe(0);

    setup.elements[0]?.emit("playing");
    setup.elements[0]?.emit("ended");
    await first.result;
    expect(setup.elements).toHaveLength(1);
  });

  it("cancels active playback idempotently and ignores stale ended events", async () => {
    const setup = playbackFixture();
    let completed = 0;
    const handle = setup.playback.enqueue({
      id: "a",
      source: "/a.wav",
      callbacks: { onCompleted: () => { completed += 1; } }
    });
    const element = setup.elements[0];
    element?.emit("playing");
    expect(await handle.started).toBe(true);

    handle.cancel();
    handle.cancel();
    expect(await handle.result).toEqual({ id: "a", status: "CANCELLED" });
    element?.emit("ended");
    await Promise.resolve();

    expect(completed).toBe(0);
    expect(element?.listenerCount()).toBe(0);
    expect(element?.pauseCount).toBe(1);
    expect(element?.src).toBe("");
  });

  it("interrupts active playback distinctly from cancellation", async () => {
    const setup = playbackFixture();
    let interrupted = 0;
    const handle = setup.playback.enqueue({
      id: "a",
      source: "/a.wav",
      callbacks: { onInterrupted: () => { interrupted += 1; } }
    });
    setup.elements[0]?.emit("playing");
    await handle.started;

    setup.playback.interruptCurrent();
    expect(await handle.result).toEqual({ id: "a", status: "INTERRUPTED" });
    await Promise.resolve();
    expect(interrupted).toBe(1);
  });

  it("reports playback errors and does not fire completion", async () => {
    const element = new FakeAudioElement();
    element.playError = new Error("autoplay rejected");
    const playback = new BrowserAudioPlayback(() => element);
    let completed = 0;
    let failed = 0;
    const handle = playback.enqueue({
      id: "a",
      source: "/a.wav",
      callbacks: {
        onCompleted: () => { completed += 1; },
        onFailed: () => { failed += 1; }
      }
    });

    expect(await handle.started).toBe(false);
    const outcome = await handle.result;
    expect(outcome.status).toBe("FAILED");
    expect(outcome.error?.code).toBe("PLAYBACK_FAILED");
    await Promise.resolve();
    expect(failed).toBe(1);
    expect(completed).toBe(0);
    expect(element.listenerCount()).toBe(0);
  });

  it("preserves duplicate ambiguity during reentrant disposal teardown", () => {
    const element = new FakeAudioElement();
    const playback = new BrowserAudioPlayback(() => element);
    playback.enqueue({ id: "same-id", source: "/first.wav" });
    element.emit("playing");

    let reentrantError: AudioInfrastructureError | undefined;
    element.onPause = () => {
      try {
        playback.enqueue({ id: "same-id", source: "/second.wav" });
      } catch (error) {
        if (error instanceof AudioInfrastructureError) reentrantError = error;
      }
    };

    playback.dispose();

    expect(reentrantError?.code).toBe("DUPLICATE_ID");
    expect(playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
  });

  it("prevents cancellation callbacks from repopulating a direct clearQueued operation", () => {
    const setup = playbackFixture();
    let reentrantError: AudioInfrastructureError | undefined;

    setup.playback.enqueue({ id: "current", source: "/current.wav" });
    setup.playback.enqueue({
      id: "queued",
      source: "/queued.wav",
      callbacks: {
        onCancelled: () => {
          try {
            setup.playback.enqueue({ id: "reentrant", source: "/reentrant.wav" });
          } catch (error) {
            if (error instanceof AudioInfrastructureError) reentrantError = error;
          }
        }
      }
    });

    setup.playback.clearQueued();

    expect(reentrantError?.code).toBe("CANCELLED");
    expect(setup.playback.snapshot()).toEqual({ currentId: "current", queuedIds: [] });
    expect(setup.elements).toHaveLength(1);

    setup.playback.cancel("current");
  });

  it("does not let queued cancellation observers reclassify the current item during cancelAll", async () => {
    const setup = playbackFixture();
    const interrupted = vi.fn();
    const current = setup.playback.enqueue({
      id: "current",
      source: "/current.wav",
      callbacks: { onInterrupted: interrupted }
    });
    const queued = setup.playback.enqueue({
      id: "queued",
      source: "/queued.wav",
      callbacks: {
        onCancelled: () => {
          setup.playback.interruptCurrent();
        }
      }
    });

    setup.playback.cancelAll();

    expect((await current.result).status).toBe("CANCELLED");
    expect((await queued.result).status).toBe("CANCELLED");
    expect(interrupted).not.toHaveBeenCalled();
    expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
  });

  it("prevents cancellation callbacks from re-enqueuing work during cancelAll", () => {
    const setup = playbackFixture();
    let reentrantError: AudioInfrastructureError | undefined;

    setup.playback.enqueue({ id: "current", source: "/current.wav" });
    setup.playback.enqueue({
      id: "queued",
      source: "/queued.wav",
      callbacks: {
        onCancelled: () => {
          try {
            setup.playback.enqueue({ id: "reentrant", source: "/reentrant.wav" });
          } catch (error) {
            if (error instanceof AudioInfrastructureError) reentrantError = error;
          }
        }
      }
    });

    setup.playback.cancelAll();

    expect(reentrantError?.code).toBe("CANCELLED");
    expect(setup.playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
    expect(setup.elements).toHaveLength(1);
  });

  it("clears queued items, disposes resources, and rejects later enqueue", async () => {
    const setup = playbackFixture();
    const first = setup.playback.enqueue({ id: "a", source: "/a.wav" });
    const second = setup.playback.enqueue({ id: "b", source: "/b.wav" });

    setup.playback.clearQueued();
    expect(await second.result).toEqual({ id: "b", status: "CANCELLED" });

    setup.playback.dispose();
    setup.playback.dispose();
    expect(await first.result).toEqual({ id: "a", status: "CANCELLED" });
    expect(setup.elements[0]?.listenerCount()).toBe(0);
    expect(() => setup.playback.enqueue({ id: "c", source: "/c.wav" })).toThrow(
      AudioInfrastructureError
    );
  });

  it("enforces a bounded playback queue", () => {
    const setup = playbackFixture(1);
    setup.playback.enqueue({ id: "a", source: "/a.wav" });
    expect(() => setup.playback.enqueue({ id: "b", source: "/b.wav" })).toThrow(/queue is full/u);
  });

  it("keeps validated playback queue capacity immutable through ordinary runtime assignment", () => {
    const setup = playbackFixture(2);

    expect(Reflect.set(setup.playback, "maxQueueSize", Number.NaN)).toBe(false);
    expect(setup.playback.maxQueueSize).toBe(2);

    const first = setup.playback.enqueue({ id: "a", source: "/a.wav" });
    setup.playback.enqueue({ id: "b", source: "/b.wav" });
    try {
      setup.playback.enqueue({ id: "c", source: "/c.wav" });
      throw new Error("Expected immutable queue capacity to reject third item");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("QUEUE_FULL");
    }

    first.cancel();
  });

  it("settles completion exactly once and does not let an async completion observer block the queue", async () => {
    const setup = playbackFixture();
    let releaseCompletion: (() => void) | undefined;
    let completedCalls = 0;
    const first = setup.playback.enqueue({
      id: "a",
      source: "/a.wav",
      callbacks: {
        onCompleted: () => {
          completedCalls += 1;
          return new Promise<void>((resolve) => {
            releaseCompletion = resolve;
          });
        }
      }
    });
    const second = setup.playback.enqueue({ id: "b", source: "/b.wav" });

    setup.elements[0]?.emit("playing");
    await first.started;
    setup.elements[0]?.emit("ended");
    setup.elements[0]?.emit("ended");

    expect(await first.result).toEqual({ id: "a", status: "COMPLETED" });
    expect(completedCalls).toBe(1);
    expect(setup.playback.snapshot().currentId).toBe("b");

    if (releaseCompletion === undefined) throw new Error("Completion resolver was not installed");
    releaseCompletion();
    second.cancel();
    await second.result;
  });

  it("settles before teardown so reentrant pause cancellation cannot change the terminal outcome", async () => {
    const element = new FakeAudioElement();
    const playback = new BrowserAudioPlayback(() => element);
    let completed = 0;
    let cancelled = 0;
    const handle = playback.enqueue({
      id: "a",
      source: "/a.wav",
      callbacks: {
        onCompleted: () => { completed += 1; },
        onCancelled: () => { cancelled += 1; }
      }
    });
    element.onPause = () => handle.cancel();

    element.emit("playing");
    await handle.started;
    element.emit("ended");

    expect(await handle.result).toEqual({ id: "a", status: "COMPLETED" });
    await Promise.resolve();
    expect(completed).toBe(1);
    expect(cancelled).toBe(0);
  });

  it("rejects element reuse while the previous setup coroutine is still unwinding", async () => {
    const element = new FakeAudioElement();
    element.play = () => new Promise<void>(() => undefined);
    const playback = new BrowserAudioPlayback(() => element);

    const first = playback.enqueue({ id: "first", source: "/first.wav" });
    const second = playback.enqueue({ id: "second", source: "/second.wav" });

    element.emit("playing");
    expect(await first.started).toBe(true);
    element.emit("ended");
    expect((await first.result).status).toBe("COMPLETED");

    expect(await second.started).toBe(false);
    const secondOutcome = await second.result;
    expect(secondOutcome.status).toBe("FAILED");
    expect(secondOutcome.error?.code).toBe("PLAYBACK_FAILED");

    await Promise.resolve();
    await Promise.resolve();
    expect(playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
  });

  it("does not start the next item reentrantly before active element teardown finishes", async () => {
    const elements: FakeAudioElement[] = [];
    const playback = new BrowserAudioPlayback(() => {
      const element = new FakeAudioElement();
      elements.push(element);
      return element;
    });
    const first = playback.enqueue({ id: "a", source: "/a.wav" });
    let second: ReturnType<BrowserAudioPlayback["enqueue"]> | undefined;
    const firstElement = elements[0];
    if (firstElement === undefined) throw new Error("Expected first playback element");
    firstElement.onPause = () => {
      second = playback.enqueue({ id: "b", source: "/b.wav" });
      expect(elements).toHaveLength(1);
    };

    elements[0]?.emit("playing");
    await first.started;
    elements[0]?.emit("ended");
    expect((await first.result).status).toBe("COMPLETED");

    expect(elements).toHaveLength(2);
    if (second === undefined) throw new Error("Reentrant enqueue did not run");
    second.cancel();
    await second.result;
  });

  it("snapshots queued playback metadata and callbacks when work is accepted", async () => {
    const setup = playbackFixture();
    const blocker = setup.playback.enqueue({ id: "blocker", source: "/blocker.wav" });
    let originalStarts = 0;
    let mutatedStarts = 0;
    const request = {
      id: "queued",
      source: "/original.wav",
      callbacks: {
        onStarted: () => {
          originalStarts += 1;
        }
      }
    };
    const queued = setup.playback.enqueue(request);

    request.id = "mutated";
    request.source = "/mutated.wav";
    request.callbacks.onStarted = () => {
      mutatedStarts += 1;
    };

    expect(setup.playback.snapshot().queuedIds).toEqual(["queued"]);
    setup.elements[0]?.emit("playing");
    setup.elements[0]?.emit("ended");
    await blocker.result;

    expect(setup.elements[1]?.src).toBe("/original.wav");
    setup.elements[1]?.emit("playing");
    expect(await queued.started).toBe(true);
    expect(originalStarts).toBe(1);
    expect(mutatedStarts).toBe(0);
    setup.elements[1]?.emit("ended");
    expect(await queued.result).toEqual({ id: "queued", status: "COMPLETED" });
  });

  it("does not let a stale settled handle cancel a later playback that reuses the same id", async () => {
    const setup = playbackFixture();
    const first = setup.playback.enqueue({ id: "same", source: "/first.wav" });
    setup.elements[0]?.emit("playing");
    setup.elements[0]?.emit("ended");
    expect((await first.result).status).toBe("COMPLETED");

    const second = setup.playback.enqueue({ id: "same", source: "/second.wav" });
    first.cancel();

    expect(setup.playback.snapshot().currentId).toBe("same");
    setup.elements[1]?.emit("playing");
    expect(await second.started).toBe(true);
    second.cancel();
    expect((await second.result).status).toBe("CANCELLED");
  });

  it("does not inspect the returned element after the factory already cancelled playback", async () => {
    const base = new FakeAudioElement();
    let pauseReads = 0;
    const element = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "pause") {
          pauseReads += 1;
          throw new Error("pause should not be read after factory cancellation");
        }
        return proxyGet(target, property, receiver);
      }
    });
    const playback = new BrowserAudioPlayback(() => {
      playback.cancel("factory-cancel-no-inspect");
      return element;
    });

    const handle = playback.enqueue({
      id: "factory-cancel-no-inspect",
      source: "/a.wav"
    });

    expect(await handle.started).toBe(false);
    expect((await handle.result).status).toBe("CANCELLED");
    expect(pauseReads).toBe(0);
    expect(base.listenerCount()).toBe(0);
    expect(base.src).toBe("");
  });

  it("does not lose a same-id cancellation fired reentrantly by the element factory", async () => {
    const element = new FakeAudioElement();
    const playback = new BrowserAudioPlayback(() => {
      playback.cancel("factory-cancel");
      return element;
    });

    const handle = playback.enqueue({
      id: "factory-cancel",
      source: "/a.wav"
    });

    expect(await handle.started).toBe(false);
    expect((await handle.result).status).toBe("CANCELLED");
    expect(playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
    expect(element.playCount).toBe(0);
    expect(element.listenerCount()).toBe(0);
    expect(element.src).toBe("");
  });

  it("does not begin sink selection if the element factory reentrantly disposes playback", async () => {
    const element = new FakeAudioElement();
    let sinkCalls = 0;
    element.setSinkId = async () => {
      sinkCalls += 1;
    };
    const playback = new BrowserAudioPlayback(() => {
      playback.dispose();
      return element;
    });

    const handle = playback.enqueue({
      id: "factory-dispose",
      source: "/a.wav",
      outputDeviceId: "speaker-2"
    });

    expect(await handle.started).toBe(false);
    expect((await handle.result).status).toBe("CANCELLED");
    expect(sinkCalls).toBe(0);
    expect(element.src).toBe("");
    expect(element.listenerCount()).toBe(0);
  });

  it("does not invoke addEventListener if its getter disposes playback reentrantly", async () => {
    const base = new FakeAudioElement();
    let addCalls = 0;
    const element = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "addEventListener") {
          playback.dispose();
          return () => {
            addCalls += 1;
          };
        }
        return proxyGet(target, property, receiver);
      }
    });
    const playback = new BrowserAudioPlayback(() => element);

    const handle = playback.enqueue({
      id: "listener-getter-dispose",
      source: "/a.wav"
    });

    expect(await handle.started).toBe(false);
    expect((await handle.result).status).toBe("CANCELLED");
    expect(addCalls).toBe(0);
    expect(base.listenerCount()).toBe(0);
    expect(base.src).toBe("");
  });

  it("removes a listener added during reentrant disposal while listener setup is in progress", async () => {
    const element = new FakeAudioElement();
    let disposed = false;
    element.onAddListener = () => {
      if (disposed) return;
      disposed = true;
      playback.dispose();
    };
    const playback = new BrowserAudioPlayback(() => element);

    const handle = playback.enqueue({
      id: "listener-dispose",
      source: "/a.wav"
    });

    expect(await handle.started).toBe(false);
    expect((await handle.result).status).toBe("CANCELLED");
    expect(element.listenerCount()).toBe(0);
    expect(element.playCount).toBe(0);
    expect(element.src).toBe("");
  });

  it("re-scrubs late media mutation from a reentrant preload setter", async () => {
    const base = new FakeAudioElement();
    let triggered = false;
    const element = new Proxy(base, {
      set(target, property, value, receiver) {
        if (property === "preload" && value === "auto" && !triggered) {
          triggered = true;
          playback.cancel("preload-race");
          target.src = "/late-preload.wav";
        }
        return Reflect.set(target, property, value, receiver);
      }
    });
    const playback = new BrowserAudioPlayback(() => element);

    const handle = playback.enqueue({ id: "preload-race", source: "/initial.wav" });

    expect((await handle.result).status).toBe("CANCELLED");
    expect(base.src).toBe("");
    expect(base.listenerCount()).toBe(0);
    expect(base.playCount).toBe(0);
  });

  it("does not invoke setSinkId if its getter cancels playback reentrantly", async () => {
    const base = new FakeAudioElement();
    let sinkCalls = 0;
    const element = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "setSinkId") {
          playback.dispose();
          return async () => {
            sinkCalls += 1;
          };
        }
        return proxyGet(target, property, receiver);
      }
    });
    const playback = new BrowserAudioPlayback(() => element);
    const handle = playback.enqueue({
      id: "sink-getter-dispose",
      source: "/a.wav",
      outputDeviceId: "speaker-2"
    });

    expect(await handle.started).toBe(false);
    expect((await handle.result).status).toBe("CANCELLED");
    expect(sinkCalls).toBe(0);
    expect(base.src).toBe("");
  });

  it("re-scrubs media mutated after setSinkId reentrantly settles the item", async () => {
    const element = new FakeAudioElement();
    element.setSinkId = async () => {
      playback.cancel("sink-late");
      element.src = "/late-sink.wav";
    };
    const playback = new BrowserAudioPlayback(() => element);

    const handle = playback.enqueue({
      id: "sink-late",
      source: "/initial.wav",
      outputDeviceId: "speaker-2"
    });

    expect((await handle.result).status).toBe("CANCELLED");
    await Promise.resolve();
    expect(element.src).toBe("");
    expect(element.listenerCount()).toBe(0);
    expect(element.playCount).toBe(0);
  });

  it("re-scrubs late sink mutation even when setSinkId never settles after cancellation", async () => {
    const element = new FakeAudioElement();
    element.setSinkId = () => {
      playback.cancel("sink-never");
      element.src = "/late-sink-never.wav";
      return new Promise<void>(() => undefined);
    };
    const playback = new BrowserAudioPlayback(() => element);

    const handle = playback.enqueue({
      id: "sink-never",
      source: "/initial.wav",
      outputDeviceId: "speaker-2"
    });

    expect((await handle.result).status).toBe("CANCELLED");
    await Promise.resolve();
    await Promise.resolve();

    expect(element.src).toBe("");
    expect(element.listenerCount()).toBe(0);
    expect(element.playCount).toBe(0);
    expect(playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
  });

  it("reads setSinkId once before invoking the selected output capability", async () => {
    const base = new FakeAudioElement();
    let sinkReads = 0;
    const element = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "setSinkId") {
          sinkReads += 1;
          if (sinkReads > 1) throw new Error("setSinkId getter was reread");
          return target.setSinkId.bind(target);
        }
        return proxyGet(target, property, receiver);
      }
    });
    const playback = new BrowserAudioPlayback(() => element);
    const handle = playback.enqueue({
      id: "single-read-sink",
      source: "/a.wav",
      outputDeviceId: "speaker-2"
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(sinkReads).toBe(1);
    expect(base.sinkIds).toEqual(["speaker-2"]);
    expect(base.src).toBe("/a.wav");

    base.emit("playing");
    base.emit("ended");
    expect(await handle.result).toEqual({ id: "single-read-sink", status: "COMPLETED" });
  });

  it("waits for a cancelled sink switch to settle before reusing the element for default output", async () => {
    const element = new FakeAudioElement();
    let currentSink = "";
    let resolveFirstSink: (() => void) | undefined;
    let sinkCalls = 0;
    element.setSinkId = (deviceId: string) => {
      sinkCalls += 1;
      if (sinkCalls === 1) {
        return new Promise<void>((resolve) => {
          resolveFirstSink = () => {
            currentSink = deviceId;
            resolve();
          };
        });
      }
      currentSink = deviceId;
      return Promise.resolve();
    };

    const playback = new BrowserAudioPlayback(() => element);
    const first = playback.enqueue({
      id: "late-speaker",
      source: "/speaker.wav",
      outputDeviceId: "speaker-2"
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(sinkCalls).toBe(1);

    first.cancel();
    expect((await first.result).status).toBe("CANCELLED");
    await Promise.resolve();
    await Promise.resolve();

    const second = playback.enqueue({
      id: "default-after-late-speaker",
      source: "/default.wav",
      outputDeviceId: "default"
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(sinkCalls).toBe(1);
    expect(element.src).toBe("");

    if (resolveFirstSink === undefined) throw new Error("First sink resolver was not installed");
    resolveFirstSink();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sinkCalls).toBe(2);
    expect(currentSink).toBe("");
    expect(element.src).toBe("/default.wav");

    element.emit("playing");
    expect(await second.started).toBe(true);
    element.emit("ended");
    expect((await second.result).status).toBe("COMPLETED");
  });

  it("resets a reused element from an explicit sink back to browser-default output", async () => {
    const element = new FakeAudioElement();
    const playback = new BrowserAudioPlayback(() => element);

    const first = playback.enqueue({
      id: "speaker",
      source: "/speaker.wav",
      outputDeviceId: "speaker-2"
    });
    const second = playback.enqueue({
      id: "default-after-speaker",
      source: "/default.wav",
      outputDeviceId: "default"
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(element.sinkIds).toEqual(["speaker-2"]);

    element.emit("playing");
    expect(await first.started).toBe(true);
    element.emit("ended");
    expect((await first.result).status).toBe("COMPLETED");

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(element.sinkIds).toEqual(["speaker-2", ""]);
    expect(element.src).toBe("/default.wav");

    element.emit("playing");
    expect(await second.started).toBe(true);
    element.emit("ended");
    expect((await second.result).status).toBe("COMPLETED");
  });

  it("does not attach the media source until output-device selection completes", async () => {
    const element = new FakeAudioElement();
    let releaseSink: (() => void) | undefined;
    element.sinkGate = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    const playback = new BrowserAudioPlayback(() => element);
    const handle = playback.enqueue({
      id: "a",
      source: "/a.wav",
      outputDeviceId: "speaker-2"
    });

    await Promise.resolve();
    expect(element.src).toBe("");
    expect(element.listenerCount()).toBe(0);

    if (releaseSink === undefined) throw new Error("Sink resolver was not installed");
    releaseSink();
    await Promise.resolve();
    await Promise.resolve();

    expect(element.src).toBe("/a.wav");
    expect(element.listenerCount()).toBe(3);
    element.emit("playing");
    element.emit("ended");
    await handle.result;
  });

  it("cancels safely while output-device selection is still pending", async () => {
    const element = new FakeAudioElement();
    let releaseSink: (() => void) | undefined;
    element.sinkGate = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    const playback = new BrowserAudioPlayback(() => element);
    const handle = playback.enqueue({
      id: "a",
      source: "/a.wav",
      outputDeviceId: "speaker-2"
    });

    handle.cancel();
    expect(await handle.started).toBe(false);
    expect((await handle.result).status).toBe("CANCELLED");
    expect(element.listenerCount()).toBe(0);
    expect(element.src).toBe("");

    if (releaseSink === undefined) throw new Error("Sink resolver was not installed");
    releaseSink();
    await Promise.resolve();
    expect(element.listenerCount()).toBe(0);
  });

  it("does not invoke play if its method getter cancels playback reentrantly", async () => {
    const base = new FakeAudioElement();
    let playCalls = 0;
    const element = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "play") {
          playback.dispose();
          return async () => {
            playCalls += 1;
          };
        }
        return proxyGet(target, property, receiver);
      }
    });
    const playback = new BrowserAudioPlayback(() => element);
    const handle = playback.enqueue({
      id: "play-getter-dispose",
      source: "/a.wav"
    });

    expect(await handle.started).toBe(false);
    expect((await handle.result).status).toBe("CANCELLED");
    expect(playCalls).toBe(0);
    expect(base.listenerCount()).toBe(0);
    expect(base.src).toBe("");
  });

  it("re-scrubs a source setter that mutates media after reentrant cancellation", async () => {
    const base = new FakeAudioElement();
    let triggered = false;
    const element = new Proxy(base, {
      set(target, property, value, receiver) {
        if (property === "src" && value === "/hostile.wav" && !triggered) {
          triggered = true;
          playback.cancel("hostile-source");
          return Reflect.set(target, property, value, receiver);
        }
        return Reflect.set(target, property, value, receiver);
      }
    });
    const playback = new BrowserAudioPlayback(() => element);

    const handle = playback.enqueue({
      id: "hostile-source",
      source: "/hostile.wav"
    });

    expect((await handle.result).status).toBe("CANCELLED");
    expect(base.src).toBe("");
    expect(base.listenerCount()).toBe(0);
    expect(playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
  });

  it("re-scrubs late play mutation even when play never settles after cancellation", async () => {
    const element = new FakeAudioElement();
    element.play = () => {
      playback.cancel("play-never");
      element.src = "/late-play-never.wav";
      return new Promise<void>(() => undefined);
    };
    const playback = new BrowserAudioPlayback(() => element);

    const handle = playback.enqueue({
      id: "play-never",
      source: "/initial.wav"
    });

    expect((await handle.result).status).toBe("CANCELLED");
    await Promise.resolve();
    await Promise.resolve();

    expect(element.src).toBe("");
    expect(element.listenerCount()).toBe(0);
    expect(playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
  });

  it("re-scrubs media mutated after play reentrantly settles the item", async () => {
    const element = new FakeAudioElement();
    element.play = () => {
      playback.cancel("hostile-play");
      element.src = "/late-after-cancel.wav";
      return Promise.resolve();
    };
    const playback = new BrowserAudioPlayback(() => element);

    const handle = playback.enqueue({
      id: "hostile-play",
      source: "/initial.wav"
    });

    expect((await handle.result).status).toBe("CANCELLED");
    await Promise.resolve();
    expect(element.src).toBe("");
    expect(element.listenerCount()).toBe(0);
    expect(playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
  });

  it("continues teardown when independent media-element cleanup operations throw", async () => {
    const element = new FakeAudioElement();
    element.pauseError = new Error("pause failed");
    element.removeAttributeError = new Error("remove src failed");
    const playback = new BrowserAudioPlayback(() => element);
    const handle = playback.enqueue({ id: "a", source: "/a.wav" });

    element.emit("playing");
    handle.cancel();

    expect((await handle.result).status).toBe("CANCELLED");
    expect(element.listenerCount()).toBe(0);
    expect(element.pauseCount).toBe(1);
    expect(element.removeAttributeCount).toBe(1);
    expect(element.src).toBe("");
    expect(element.loadCount).toBe(1);
    expect(playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
  });

  it("uses the pause capability owned before playback starts during cancellation", async () => {
    const base = new FakeAudioElement();
    const stablePause = base.pause.bind(base);
    const element = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "pause") {
          if (target.playCount > 0) throw new Error("pause capability changed after playback started");
          return stablePause;
        }
        return proxyGet(target, property, receiver);
      }
    });
    const playback = new BrowserAudioPlayback(() => element);
    const handle = playback.enqueue({ id: "stable-pause", source: "/a.wav" });

    base.emit("playing");
    expect(await handle.started).toBe(true);
    handle.cancel();

    expect((await handle.result).status).toBe("CANCELLED");
    expect(base.pauseCount).toBe(1);
    expect(base.src).toBe("");
  });

  it("uses the snapshotted listener-removal capability during teardown", async () => {
    const base = new FakeAudioElement();
    let removalReads = 0;
    const stableRemove = base.removeEventListener.bind(base);
    const element = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "removeEventListener") {
          removalReads += 1;
          if (removalReads > 1) throw new Error("removeEventListener was reread during teardown");
          return stableRemove;
        }
        return proxyGet(target, property, receiver);
      }
    });
    const playback = new BrowserAudioPlayback(() => element);
    const handle = playback.enqueue({ id: "stable-removal", source: "/a.wav" });

    base.emit("playing");
    expect(await handle.started).toBe(true);
    handle.cancel();

    expect((await handle.result).status).toBe("CANCELLED");
    expect(removalReads).toBe(1);
    expect(base.listenerCount()).toBe(0);
  });

  it("falls back to direct source clearing when removeAttribute lookup itself throws", async () => {
    const base = new FakeAudioElement();
    const element = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "removeAttribute") throw new Error("removeAttribute getter failed");
        return proxyGet(target, property, receiver);
      }
    });
    const playback = new BrowserAudioPlayback(() => element);
    const handle = playback.enqueue({ id: "getter-cleanup", source: "/a.wav" });

    base.emit("playing");
    handle.cancel();

    expect((await handle.result).status).toBe("CANCELLED");
    expect(base.src).toBe("");
    expect(playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
  });

  it("settles and advances the queue when a thrown playback value has a hostile name accessor", async () => {
    const hostileError = {};
    Object.defineProperty(hostileError, "name", {
      get: () => {
        throw new Error("name getter failed");
      }
    });
    const setup = playbackFixture();
    const hostileElement = setup.elements[0];
    if (hostileElement === undefined) throw new Error("Expected playback element");
    hostileElement.play = () => Promise.reject(hostileError);
    const first = setup.playback.enqueue({ id: "hostile", source: "/hostile.wav" });
    const second = setup.playback.enqueue({ id: "next", source: "/next.wav" });

    const firstOutcome = await first.result;
    expect(firstOutcome.status).toBe("FAILED");
    expect(firstOutcome.error?.code).toBe("PLAYBACK_FAILED");
    expect(setup.playback.snapshot().currentId).toBe("next");

    second.cancel();
    await second.result;
  });

  it("maps autoplay policy rejection to a typed permission failure", async () => {
    const element = new FakeAudioElement();
    element.playError = Object.assign(new Error("autoplay blocked"), { name: "NotAllowedError" });
    const playback = new BrowserAudioPlayback(() => element);
    const handle = playback.enqueue({ id: "blocked", source: "/blocked.wav" });

    expect(await handle.started).toBe(false);
    const outcome = await handle.result;
    expect(outcome.status).toBe("FAILED");
    expect(outcome.error?.code).toBe("PERMISSION_DENIED");
  });

  it("maps output-device permission and disappearance failures to typed outcomes", async () => {
    const denied = new FakeAudioElement();
    denied.sinkError = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
    const deniedPlayback = new BrowserAudioPlayback(() => denied);
    const deniedHandle = deniedPlayback.enqueue({
      id: "denied",
      source: "/a.wav",
      outputDeviceId: "speaker-private"
    });
    expect((await deniedHandle.result).error?.code).toBe("PERMISSION_DENIED");

    const missing = new FakeAudioElement();
    missing.sinkError = Object.assign(new Error("gone"), { name: "NotFoundError" });
    const missingPlayback = new BrowserAudioPlayback(() => missing);
    const missingHandle = missingPlayback.enqueue({
      id: "missing",
      source: "/a.wav",
      outputDeviceId: "speaker-gone"
    });
    expect((await missingHandle.result).error?.code).toBe("DEVICE_UNAVAILABLE");
  });

  it("returns typed DUPLICATE_ID for duplicate playback admission", () => {
    const setup = playbackFixture();
    setup.playback.enqueue({ id: "duplicate", source: "/first.wav" });

    try {
      setup.playback.enqueue({ id: "duplicate", source: "/second.wav" });
      throw new Error("Expected duplicate playback admission to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AudioInfrastructureError);
      expect((error as AudioInfrastructureError).code).toBe("DUPLICATE_ID");
    }

    setup.playback.cancel("duplicate");
  });

  it("does not misclassify a full queue when the same delivery id is already pending", async () => {
    const setup = playbackFixture(1);
    const deliveryId = newDeliveryId();
    const preexisting = setup.playback.enqueue({
      id: deliveryId,
      source: "/preexisting.wav"
    });
    const client = new RendererClient({
      sessionId: newSessionId(),
      acknowledgementSender: { send: async () => undefined },
      textPresenter: { presentText: () => undefined },
      audioPlayer: new QueuedRendererAudioPlayer(setup.playback)
    });
    const message = RendererStreamMessageSchema.parse({
      protocolVersion: 1,
      type: "DELIVERY_COMMAND",
      command: {
        deliveryId,
        content: {
          medium: "AUDIO",
          text: "Ambiguous duplicate",
          audioRef: "/duplicate.wav"
        }
      }
    });

    await expect(client.handleMessage(message)).rejects.toThrow(/already pending/u);
    expect(client.snapshot()).toMatchObject([
      { deliveryId, phase: "RECEIVED" }
    ]);

    preexisting.cancel();
    await preexisting.result;
  });

  it("lets the renderer retry after a bounded player definitely rejects before exposure", async () => {
    const setup = playbackFixture(1);
    const blocker = setup.playback.enqueue({ id: "blocker", source: "/blocker.wav" });
    const audioPlayer = new QueuedRendererAudioPlayer(setup.playback);
    const client = new RendererClient({
      sessionId: newSessionId(),
      acknowledgementSender: { send: async () => undefined },
      textPresenter: { presentText: () => undefined },
      audioPlayer
    });
    const deliveryId = newDeliveryId();
    const message = RendererStreamMessageSchema.parse({
      protocolVersion: 1,
      type: "DELIVERY_COMMAND",
      command: {
        deliveryId,
        content: {
          medium: "AUDIO",
          text: "Queued probe",
          audioRef: "/queued.wav"
        }
      }
    });

    await expect(client.handleMessage(message)).rejects.toBeInstanceOf(
      RendererPresentationNotExposedError
    );
    expect(client.snapshot()).toEqual([]);

    blocker.cancel();
    await blocker.result;

    const retried = client.handleMessage(message);
    setup.elements[1]?.emit("playing");
    await retried;
    expect(client.snapshot()[0]?.phase).toBe("EXPOSED");
  });

  it("sets a selected output sink when supported", async () => {
    const setup = playbackFixture();
    const handle = setup.playback.enqueue({
      id: "a",
      source: "/a.wav",
      outputDeviceId: "speaker-2"
    });
    await Promise.resolve();
    expect(setup.elements[0]?.sinkIds).toEqual(["speaker-2"]);
    setup.elements[0]?.emit("playing");
    setup.elements[0]?.emit("ended");
    await handle.result;
  });

  it("plays on default-output aliases without requiring setSinkId support", async () => {
    const makeElement = (): BrowserAudioElementLike => ({
      src: "",
      preload: "",
      currentTime: 0,
      play: async () => undefined,
      pause: () => undefined,
      load: () => undefined,
      addEventListener: (_type, listener) => {
        if (_type === "playing") queueMicrotask(listener);
        if (_type === "ended") queueMicrotask(listener);
      },
      removeEventListener: () => undefined
    });

    for (const outputDeviceId of ["default", ""] as const) {
      const playback = new BrowserAudioPlayback(() => makeElement());
      const handle = playback.enqueue({
        id: `default-output-${outputDeviceId || "empty"}`,
        source: "/a.wav",
        outputDeviceId
      });

      expect(await handle.started).toBe(true);
      expect((await handle.result).status).toBe("COMPLETED");
    }
  });

  it("fails explicitly when selected output sink is unsupported", async () => {
    const element: BrowserAudioElementLike = {
      src: "",
      preload: "",
      currentTime: 0,
      play: async () => undefined,
      pause: () => undefined,
      load: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    };
    const playback = new BrowserAudioPlayback(() => element);
    const handle = playback.enqueue({
      id: "a",
      source: "/a.wav",
      outputDeviceId: "speaker-2"
    });

    expect(await handle.started).toBe(false);
    const outcome = await handle.result;
    expect(outcome.status).toBe("FAILED");
    expect(outcome.error?.code).toBe("OUTPUT_DEVICE_UNSUPPORTED");
  });
});
