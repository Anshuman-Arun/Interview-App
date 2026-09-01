import { describe, expect, it, vi } from "vitest";
import { newDeliveryId } from "../packages/domain/src/index.js";
import {
  BrowserAudioPlayback,
  BrowserMicrophoneCapture,
  QueuedRendererAudioPlayer,
  RendererPresentationNotExposedError,
  type AudioMediaDevicesLike,
  type AudioMediaStreamLike,
  type AudioMediaStreamTrackLike,
  type BrowserAudioElementLike,
  type BrowserMicrophoneCaptureEnvironment,
  type CaptureAudioContextLike,
  type CaptureAudioNodeLike,
  type CaptureScriptProcessorLike
} from "../apps/web/src/index.js";

class Deferred<T> {
  public readonly promise: Promise<T>;
  private resolveValue!: (value: T | PromiseLike<T>) => void;

  public constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolveValue = resolve;
    });
  }

  public resolve(value: T): void {
    this.resolveValue(value);
  }
}

class Track implements AudioMediaStreamTrackLike {
  public readonly readyState = "live" as const;
  public stopCount = 0;
  public readonly listeners = new Set<() => void>();

  public stop(): void {
    this.stopCount += 1;
  }

  public addEventListener(_type: "ended", listener: () => void): void {
    this.listeners.add(listener);
  }

  public removeEventListener(_type: "ended", listener: () => void): void {
    this.listeners.delete(listener);
  }

  public emitEnded(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

class Stream implements AudioMediaStreamLike {
  public constructor(public readonly track = new Track()) {}

  public getAudioTracks(): readonly AudioMediaStreamTrackLike[] {
    return [this.track];
  }
}

class NodeLike implements CaptureAudioNodeLike {
  public disconnectCount = 0;
  public connect(): void {}
  public disconnect(): void {
    this.disconnectCount += 1;
  }
}

class Processor extends NodeLike implements CaptureScriptProcessorLike {
  public onaudioprocess = null;
}

class DeferredCloseContext implements CaptureAudioContextLike {
  public readonly sampleRate = 16_000;
  public readonly destination = {};
  public readonly source = new NodeLike();
  public readonly processor = new Processor();
  public closeCount = 0;
  public readonly closeDeferred = new Deferred<void>();

  public createMediaStreamSource(): CaptureAudioNodeLike {
    return this.source;
  }

  public createScriptProcessor(): CaptureScriptProcessorLike {
    return this.processor;
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
    await this.closeDeferred.promise;
  }
}

function captureFixture(options: { readonly deferredGetUserMedia?: boolean } = {}): {
  readonly capture: BrowserMicrophoneCapture;
  readonly stream: Stream;
  readonly context: DeferredCloseContext;
  readonly getUserMedia: Deferred<AudioMediaStreamLike> | undefined;
} {
  const stream = new Stream();
  const context = new DeferredCloseContext();
  const getUserMedia = options.deferredGetUserMedia ? new Deferred<AudioMediaStreamLike>() : undefined;
  const mediaDevices: AudioMediaDevicesLike = {
    getUserMedia: async () => getUserMedia === undefined ? stream : getUserMedia.promise,
    enumerateDevices: async () => [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
  const environment: BrowserMicrophoneCaptureEnvironment = {
    mediaDevices,
    createAudioContext: () => context,
    now: () => 0
  };
  return {
    capture: new BrowserMicrophoneCapture(environment),
    stream,
    context,
    getUserMedia
  };
}

describe("microphone lifecycle adversarial ordering", () => {
  it("stops an unpublished stream when getAudioTracks access supersedes start", async () => {
    const track = new Track();
    let capture!: BrowserMicrophoneCapture;
    let stopping: Promise<void> | undefined;
    let getterReads = 0;
    const stream = {} as AudioMediaStreamLike;
    Object.defineProperty(stream, "getAudioTracks", {
      configurable: true,
      get: () => {
        getterReads += 1;
        if (getterReads === 1) stopping = capture.stop();
        return () => [track];
      }
    });
    const createAudioContext = vi.fn(() => new DeferredCloseContext());
    capture = new BrowserMicrophoneCapture({
      mediaDevices: {
        getUserMedia: async () => stream
      },
      createAudioContext,
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });
    await stopping;

    expect(capture.state).toBe("STOPPED");
    expect(track.stopCount).toBe(1);
    expect(createAudioContext).not.toHaveBeenCalled();
    expect(getterReads).toBeGreaterThanOrEqual(2);
  });

  it("lets dispose win immediately during a track readyState read", async () => {
    let capture!: BrowserMicrophoneCapture;
    let disposing: Promise<void> | undefined;
    let readyStateReads = 0;
    const track: AudioMediaStreamTrackLike & { stopCount: number } = {
      stopCount: 0,
      get readyState(): AudioMediaStreamTrackLike["readyState"] {
        readyStateReads += 1;
        if (readyStateReads === 1) disposing = capture.dispose();
        return "live";
      },
      stop() {
        this.stopCount += 1;
      },
      addEventListener() {},
      removeEventListener() {}
    };
    const stream: AudioMediaStreamLike = {
      getAudioTracks: () => [track]
    };
    const createAudioContext = vi.fn(() => new DeferredCloseContext());
    capture = new BrowserMicrophoneCapture({
      mediaDevices: {
        getUserMedia: async () => stream
      },
      createAudioContext,
      now: () => 0
    });

    await capture.start({ onFrame: () => undefined });
    await disposing;

    expect(capture.state).toBe("DISPOSED");
    expect(track.stopCount).toBe(1);
    expect(createAudioContext).not.toHaveBeenCalled();
    expect(readyStateReads).toBe(1);
  });

  it("dispose dominates a pending stop even when context close resolves later", async () => {
    const setup = captureFixture();
    await setup.capture.start({ onFrame: () => undefined });

    const stopping = setup.capture.stop();
    const disposing = setup.capture.dispose();
    expect(setup.capture.state).toBe("DISPOSED");

    setup.context.closeDeferred.resolve(undefined);
    await Promise.all([stopping, disposing]);

    expect(setup.capture.state).toBe("DISPOSED");
    expect(setup.stream.track.stopCount).toBe(1);
    expect(setup.context.closeCount).toBe(1);
    expect(setup.stream.track.listeners.size).toBe(0);
  });

  it("stop cannot supersede a dispose whose cleanup is pending", async () => {
    const setup = captureFixture();
    await setup.capture.start({ onFrame: () => undefined });

    const disposing = setup.capture.dispose();
    const stopping = setup.capture.stop();
    expect(setup.capture.state).toBe("DISPOSED");

    setup.context.closeDeferred.resolve(undefined);
    await Promise.all([disposing, stopping]);
    expect(setup.capture.state).toBe("DISPOSED");
    expect(setup.context.closeCount).toBe(1);
  });

  it("late getUserMedia cannot attach resources after disposal", async () => {
    const setup = captureFixture({ deferredGetUserMedia: true });
    const starting = setup.capture.start({ onFrame: () => undefined });
    await Promise.resolve();

    await setup.capture.dispose();
    setup.getUserMedia?.resolve(setup.stream);
    await starting;

    expect(setup.capture.state).toBe("DISPOSED");
    expect(setup.stream.track.stopCount).toBe(1);
    expect(setup.stream.track.listeners.size).toBe(0);
    expect(setup.context.closeCount).toBe(0);
    await expect(setup.capture.start({ onFrame: () => undefined })).rejects.toMatchObject({ code: "DISPOSED" });
  });

  it("dispose dominates restart and stale track-ended callbacks", async () => {
    const setup = captureFixture();
    await setup.capture.start({ onFrame: () => undefined });
    const ended = [...setup.stream.track.listeners][0];

    const restarting = setup.capture.restart({ onFrame: () => undefined });
    await Promise.resolve();
    const disposing = setup.capture.dispose();
    ended?.();

    setup.context.closeDeferred.resolve(undefined);
    await disposing;
    await expect(restarting).rejects.toMatchObject({ code: "DISPOSED" });
    await Promise.resolve();

    expect(setup.capture.state).toBe("DISPOSED");
    expect(setup.stream.track.stopCount).toBe(1);
    expect(setup.stream.track.listeners.size).toBe(0);
  });
});

class AudioElement implements BrowserAudioElementLike {
  public src = "";
  public preload = "";
  public currentTime = 0;
  public readonly listeners = new Map<"playing" | "ended" | "error", Set<() => void>>([
    ["playing", new Set()],
    ["ended", new Set()],
    ["error", new Set()]
  ]);
  public playError: Error | undefined;

  public async play(): Promise<void> {
    if (this.playError !== undefined) throw this.playError;
  }

  public pause(): void {}
  public load(): void {}
  public addEventListener(type: "playing" | "ended" | "error", listener: () => void): void {
    this.listeners.get(type)?.add(listener);
  }
  public removeEventListener(type: "playing" | "ended" | "error", listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  public emit(type: "playing" | "ended" | "error"): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

describe("QueuedRendererAudioPlayer exposure semantics", () => {
  it("resolves presentation only on physical playing and completes only on ended", async () => {
    const elements: AudioElement[] = [];
    const playback = new BrowserAudioPlayback(() => {
      const element = new AudioElement();
      elements.push(element);
      return element;
    });
    const adapter = new QueuedRendererAudioPlayer(playback);
    const onStarted = vi.fn();
    const onCompleted = vi.fn();
    let settled = false;

    const presentation = adapter.playAudio({
      deliveryId: newDeliveryId(),
      audioRef: "fixture.wav",
      text: "fixture",
      callbacks: { onStarted, onCompleted }
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(onStarted).not.toHaveBeenCalled();

    elements[0]?.emit("playing");
    await presentation;
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onCompleted).not.toHaveBeenCalled();

    elements[0]?.emit("ended");
    await Promise.resolve();
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it("keeps temporary admission cancellation conservative instead of claiming proven non-exposure", async () => {
    const element = new AudioElement();
    const playback = new BrowserAudioPlayback(() => element);
    const adapter = new QueuedRendererAudioPlayer(playback);
    let reentrantPresentation: Promise<void> | undefined;

    playback.enqueue({ id: "current", source: "current.wav" });
    playback.enqueue({
      id: "queued-trigger",
      source: "queued.wav",
      callbacks: {
        onCancelled: () => {
          reentrantPresentation = adapter.playAudio({
            deliveryId: newDeliveryId(),
            audioRef: "new.wav",
            text: "new",
            callbacks: { onStarted: vi.fn(), onCompleted: vi.fn() }
          });
        }
      }
    });

    adapter.clearQueued();

    if (reentrantPresentation === undefined) {
      throw new Error("Expected queued cancellation callback to attempt renderer admission");
    }
    await expect(reentrantPresentation).rejects.toMatchObject({ code: "CANCELLED" });

    playback.cancel("current");
  });

  it("maps malformed pre-enqueue renderer audio to proven non-exposure", async () => {
    const elements: AudioElement[] = [];
    const adapter = new QueuedRendererAudioPlayer(new BrowserAudioPlayback(() => {
      const element = new AudioElement();
      elements.push(element);
      return element;
    }));

    await expect(adapter.playAudio({
      deliveryId: newDeliveryId(),
      audioRef: "   ",
      text: "invalid",
      callbacks: { onStarted: vi.fn(), onCompleted: vi.fn() }
    })).rejects.toBeInstanceOf(RendererPresentationNotExposedError);

    expect(elements).toHaveLength(0);
  });

  it("keeps duplicate identity ambiguous even when the second payload is malformed", async () => {
    const element = new AudioElement();
    const playback = new BrowserAudioPlayback(() => element);
    const adapter = new QueuedRendererAudioPlayer(playback);
    const deliveryId = newDeliveryId();

    const first = adapter.playAudio({
      deliveryId,
      audioRef: "first.wav",
      text: "first",
      callbacks: { onStarted: vi.fn(), onCompleted: vi.fn() }
    });
    await Promise.resolve();
    element.emit("playing");
    await first;

    await expect(adapter.playAudio({
      deliveryId,
      audioRef: "   ",
      text: "malformed duplicate",
      callbacks: { onStarted: vi.fn(), onCompleted: vi.fn() }
    })).rejects.toMatchObject({ code: "DUPLICATE_ID" });

    adapter.cancelDelivery(deliveryId);
  });

  it("keeps duplicate pending delivery ambiguous instead of claiming proven non-exposure", async () => {
    const element = new AudioElement();
    const playback = new BrowserAudioPlayback(() => element);
    const adapter = new QueuedRendererAudioPlayer(playback);
    const deliveryId = newDeliveryId();

    const first = adapter.playAudio({
      deliveryId,
      audioRef: "first.wav",
      text: "first",
      callbacks: { onStarted: vi.fn(), onCompleted: vi.fn() }
    });
    await Promise.resolve();

    await expect(adapter.playAudio({
      deliveryId,
      audioRef: "second.wav",
      text: "second",
      callbacks: { onStarted: vi.fn(), onCompleted: vi.fn() }
    })).rejects.toMatchObject({ code: "DUPLICATE_ID" });

    adapter.cancelDelivery(deliveryId);
    await expect(first).rejects.toBeInstanceOf(RendererPresentationNotExposedError);
  });

  it("cancellation before playing rejects as not exposed and stale playing is ignored", async () => {
    const element = new AudioElement();
    const playback = new BrowserAudioPlayback(() => element);
    const adapter = new QueuedRendererAudioPlayer(playback);
    const deliveryId = newDeliveryId();
    const onStarted = vi.fn();
    const onCompleted = vi.fn();

    const presentation = adapter.playAudio({
      deliveryId,
      audioRef: "fixture.wav",
      text: "fixture",
      callbacks: { onStarted, onCompleted }
    });
    await Promise.resolve();
    adapter.cancelDelivery(deliveryId);

    await expect(presentation).rejects.toBeInstanceOf(RendererPresentationNotExposedError);
    element.emit("playing");
    element.emit("ended");
    await Promise.resolve();
    expect(onStarted).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it("failure before playing is not exposure, while interruption after playing suppresses completion", async () => {
    const failing = new AudioElement();
    failing.playError = new Error("blocked");
    const failedAdapter = new QueuedRendererAudioPlayer(new BrowserAudioPlayback(() => failing));
    await expect(failedAdapter.playAudio({
      deliveryId: newDeliveryId(),
      audioRef: "bad.wav",
      text: "bad",
      callbacks: { onStarted: vi.fn(), onCompleted: vi.fn() }
    })).rejects.toBeInstanceOf(RendererPresentationNotExposedError);

    const element = new AudioElement();
    const adapter = new QueuedRendererAudioPlayer(new BrowserAudioPlayback(() => element));
    const onStarted = vi.fn();
    const onCompleted = vi.fn();
    const presentation = adapter.playAudio({
      deliveryId: newDeliveryId(),
      audioRef: "good.wav",
      text: "good",
      callbacks: { onStarted, onCompleted }
    });
    await Promise.resolve();
    element.emit("playing");
    await presentation;
    adapter.interruptCurrent();
    element.emit("ended");
    await Promise.resolve();

    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it("preserves FIFO order, rejects duplicate pending ids, and disposal clears owned elements", async () => {
    const elements: AudioElement[] = [];
    const playback = new BrowserAudioPlayback(() => {
      const element = new AudioElement();
      elements.push(element);
      return element;
    });
    const adapter = new QueuedRendererAudioPlayer(playback);
    const first = newDeliveryId();
    const second = newDeliveryId();

    const firstPresentation = adapter.playAudio({
      deliveryId: first,
      audioRef: "1.wav",
      text: "1",
      callbacks: { onStarted: vi.fn(), onCompleted: vi.fn() }
    });
    const secondPresentation = adapter.playAudio({
      deliveryId: second,
      audioRef: "2.wav",
      text: "2",
      callbacks: { onStarted: vi.fn(), onCompleted: vi.fn() }
    });
    await expect(adapter.playAudio({
      deliveryId: second,
      audioRef: "duplicate.wav",
      text: "duplicate",
      callbacks: { onStarted: vi.fn(), onCompleted: vi.fn() }
    })).rejects.toMatchObject({ code: "DUPLICATE_ID" });

    await Promise.resolve();
    expect(elements).toHaveLength(1);
    elements[0]?.emit("playing");
    await firstPresentation;
    elements[0]?.emit("ended");
    await Promise.resolve();
    await Promise.resolve();
    expect(elements).toHaveLength(2);

    elements[1]?.emit("playing");
    await secondPresentation;
    adapter.dispose();
    expect(playback.snapshot()).toEqual({ currentId: undefined, queuedIds: [] });
    for (const element of elements) {
      expect(element.listeners.get("playing")?.size).toBe(0);
      expect(element.listeners.get("ended")?.size).toBe(0);
      expect(element.listeners.get("error")?.size).toBe(0);
    }
  });
});
