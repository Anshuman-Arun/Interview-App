import { AudioInfrastructureError } from "./types.js";

export type AudioPlaybackOutcomeStatus = "COMPLETED" | "CANCELLED" | "INTERRUPTED" | "FAILED";

export interface AudioPlaybackOutcome {
  readonly id: string;
  readonly status: AudioPlaybackOutcomeStatus;
  readonly error?: AudioInfrastructureError;
}

export interface BrowserAudioPlaybackCallbacks {
  readonly onStarted?: () => void | Promise<void>;
  readonly onCompleted?: () => void | Promise<void>;
  readonly onCancelled?: () => void | Promise<void>;
  readonly onInterrupted?: () => void | Promise<void>;
  readonly onFailed?: (error: AudioInfrastructureError) => void | Promise<void>;
}

export interface PlayableAudio {
  readonly id: string;
  readonly source: string;
  readonly outputDeviceId?: string;
  readonly callbacks?: BrowserAudioPlaybackCallbacks;
}

const PLAYBACK_CALLBACK_NAMES: ReadonlySet<string> = new Set([
  "onStarted",
  "onCompleted",
  "onCancelled",
  "onInterrupted",
  "onFailed"
]);

export interface AudioPlaybackHandle {
  readonly id: string;
  readonly started: Promise<boolean>;
  readonly result: Promise<AudioPlaybackOutcome>;
  readonly cancel: () => void;
}

export interface BrowserAudioElementLike {
  src: string;
  preload: string;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: "playing" | "ended" | "error", listener: () => void): void;
  removeEventListener(type: "playing" | "ended" | "error", listener: () => void): void;
  removeAttribute?(name: string): void;
  setSinkId?: (deviceId: string) => Promise<void>;
}

interface PendingPlayback {
  readonly request: PlayableAudio;
  readonly resolveStarted: (started: boolean) => void;
  readonly resolveResult: (result: AudioPlaybackOutcome) => void;
  readonly started: Promise<boolean>;
  readonly result: Promise<AudioPlaybackOutcome>;
  element: BrowserAudioElementLike | undefined;
  listeners: {
    readonly playing: () => void;
    readonly ended: () => void;
    readonly error: () => void;
  } | undefined;
  removeEventListener: BrowserAudioElementLike["removeEventListener"] | undefined;
  pause: BrowserAudioElementLike["pause"] | undefined;
  hasStarted: boolean;
  settled: boolean;
}

export class BrowserAudioPlayback {
  private readonly queue: PendingPlayback[] = [];
  private readonly admittingIds = new Set<string>();
  private readonly cancelledAdmittingIds = new Set<string>();
  private readonly admissionMutationScopes = new Set<Set<string>>();
  private readonly elementSetupOwners = new WeakMap<object, PendingPlayback>();
  private readonly elementSinkStates = new WeakMap<object, string | null>();
  private readonly elementSinkOperations = new WeakMap<object, Promise<void>>();
  private current: PendingPlayback | undefined;
  private disposed = false;
  private cancellingAll = false;
  private clearingQueued = false;
  private admissionEpoch = 0;
  private readonly queueCapacity: number;

  public constructor(
    private readonly createAudio: () => BrowserAudioElementLike = defaultAudioElement,
    maxQueueSize = 32
  ) {
    if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1) {
      throw new RangeError("Audio playback queue capacity must be a positive safe integer");
    }
    this.queueCapacity = maxQueueSize;
  }

  public get maxQueueSize(): number {
    return this.queueCapacity;
  }

  public enqueue(request: PlayableAudio): AudioPlaybackHandle {
    const mutatedIds = new Set<string>();
    this.admissionMutationScopes.add(mutatedIds);
    try {
      return this.enqueueWithinMutationScope(request, mutatedIds);
    } finally {
      this.admissionMutationScopes.delete(mutatedIds);
    }
  }

  private enqueueWithinMutationScope(
    request: PlayableAudio,
    mutatedIds: Set<string>
  ): AudioPlaybackHandle {
    const admissionEpoch = this.admissionEpoch;
    let acceptedId: string;
    try {
      const identity = snapshotPlayableAudioIdentity(request);
      validatePlayableAudioIdentity(identity);
      acceptedId = identity.id;
    } catch (error) {
      if (error instanceof AudioInfrastructureError) throw error;
      throw new AudioInfrastructureError(
        "INVALID_REQUEST",
        "Audio playback identity could not be read safely",
        { cause: error }
      );
    }

    this.assertAdmissionUnchanged(admissionEpoch);
    this.assertAdmissionIdUnchanged(mutatedIds, acceptedId);
    if (this.hasPendingId(acceptedId)) {
      throw new AudioInfrastructureError(
        "DUPLICATE_ID",
        "Audio playback id is already pending"
      );
    }

    this.admittingIds.add(acceptedId);
    try {
      this.assertUsable();
      this.assertAdmissionUnchanged(admissionEpoch);
      this.assertAdmissionIdUnchanged(mutatedIds, acceptedId);
      this.assertAdmissionNotCancelled(acceptedId);

      let acceptedRequest: PlayableAudio;
      try {
        acceptedRequest = snapshotPlayableAudioPayload(request, acceptedId);
        validatePlayableAudioPayload(acceptedRequest);
      } catch (error) {
        if (error instanceof AudioInfrastructureError) throw error;
        throw new AudioInfrastructureError(
          "INVALID_REQUEST",
          "Audio playback payload could not be read safely",
          { cause: error }
        );
      }

      this.assertUsable();
      this.assertAdmissionUnchanged(admissionEpoch);
      this.assertAdmissionIdUnchanged(mutatedIds, acceptedId);
      this.assertAdmissionNotCancelled(acceptedId);

      if (this.pendingCount() >= this.maxQueueSize) {
        throw new AudioInfrastructureError("QUEUE_FULL", "Audio playback queue is full");
      }

      let resolveStarted: ((started: boolean) => void) | undefined;
      let resolveResult: ((result: AudioPlaybackOutcome) => void) | undefined;
      const started = new Promise<boolean>((resolve) => {
        resolveStarted = resolve;
      });
      const result = new Promise<AudioPlaybackOutcome>((resolve) => {
        resolveResult = resolve;
      });

      const pending: PendingPlayback = {
        request: acceptedRequest,
        resolveStarted: resolveStarted as (started: boolean) => void,
        resolveResult: resolveResult as (result: AudioPlaybackOutcome) => void,
        started,
        result,
        element: undefined,
        listeners: undefined,
        removeEventListener: undefined,
        pause: undefined,
        hasStarted: false,
        settled: false
      };

      this.queue.push(pending);
      this.recordAdmissionMutation(acceptedId);

      // Ownership has moved from the admission reservation to the concrete
      // queued item. Release the reservation before drain() can invoke the
      // element factory or any other user/browser-controlled code.
      this.admittingIds.delete(acceptedId);
      const cancelledBeforeOwnershipTransfer = this.cancelledAdmittingIds.delete(acceptedId);
      if (cancelledBeforeOwnershipTransfer) {
        this.cancelPending(pending);
      } else {
        this.drain();
      }

      return {
        id: acceptedRequest.id,
        started,
        result,
        cancel: () => this.cancelPending(pending)
      };
    } finally {
      this.admittingIds.delete(acceptedId);
      this.cancelledAdmittingIds.delete(acceptedId);
    }
  }

  public cancel(id: string): void {
    // Record the logical ID even before an admission has installed its
    // reservation so a same-ID cancellation from an identity getter is not lost.
    this.recordAdmissionMutation(id);

    if (this.admittingIds.has(id)) {
      this.cancelledAdmittingIds.add(id);
      return;
    }

    const queued = this.queue.find((item) => item.request.id === id);
    if (queued !== undefined) {
      this.cancelPending(queued);
      return;
    }

    if (this.current?.request.id === id) {
      this.cancelPending(this.current);
    }
  }

  public interruptCurrent(): void {
    if (this.current === undefined) return;
    this.stopCurrent("INTERRUPTED");
  }

  public clearQueued(): void {
    if (this.clearingQueued) return;
    this.admissionEpoch += 1;
    this.clearingQueued = true;
    try {
      const queued = this.queue.splice(0);
      for (const pending of queued) {
        this.settleQueued(pending);
      }
    } finally {
      this.clearingQueued = false;
    }
  }

  public cancelAll(): void {
    if (this.cancellingAll) return;
    this.cancellingAll = true;
    try {
      // Settle the active item first so queued cancellation observers cannot
      // reclassify it as INTERRUPTED (or otherwise terminate it) before the
      // cancel-all command reaches it.
      if (this.current !== undefined) this.stopCurrent("CANCELLED");
      this.clearQueued();
    } finally {
      this.cancellingAll = false;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
  }

  public snapshot(): {
    readonly currentId: string | undefined;
    readonly queuedIds: readonly string[];
  } {
    return {
      currentId: this.current?.request.id,
      queuedIds: this.queue.map((item) => item.request.id)
    };
  }

  private pendingCount(): number {
    return this.queue.length + (this.current === undefined ? 0 : 1);
  }

  private hasPendingId(id: string): boolean {
    return this.admittingIds.has(id)
      || this.current?.request.id === id
      || this.queue.some((item) => item.request.id === id);
  }

  private cancelPending(pending: PendingPlayback): void {
    if (pending.settled) return;

    if (this.current === pending) {
      this.stopCurrent("CANCELLED");
      return;
    }

    const queuedIndex = this.queue.indexOf(pending);
    if (queuedIndex < 0) return;
    this.queue.splice(queuedIndex, 1);
    this.settleQueued(pending);
  }

  private drain(): void {
    if (
      this.disposed
      || this.cancellingAll
      || this.clearingQueued
      || this.current !== undefined
    ) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.current = next;
    void this.startCurrent(next);
  }

  private async startCurrent(pending: PendingPlayback): Promise<void> {
    let element: BrowserAudioElementLike | undefined;
    let elementSetupKey: object | undefined;
    try {
      element = this.createAudio();
      if (typeof element !== "object" || element === null) {
        throw new AudioInfrastructureError(
          "PLAYBACK_FAILED",
          "Audio element factory returned a non-object value"
        );
      }

      elementSetupKey = element;
      const existingSetupOwner = this.elementSetupOwners.get(elementSetupKey);
      if (existingSetupOwner !== undefined && existingSetupOwner !== pending) {
        throw new AudioInfrastructureError(
          "PLAYBACK_FAILED",
          "Audio element factory reused an element before prior setup cleanup completed"
        );
      }
      this.elementSetupOwners.set(elementSetupKey, pending);
      pending.element = element;

      let pause: BrowserAudioElementLike["pause"];
      try {
        pause = element.pause;
      } catch (error) {
        if (pending.settled || this.current !== pending) {
          this.releaseElement(pending);
          return;
        }
        throw error;
      }
      if (typeof pause !== "function") {
        throw new AudioInfrastructureError(
          "PLAYBACK_FAILED",
          "Browser audio element does not expose callable pause"
        );
      }
      pending.pause = pause;

      if (pending.settled || this.current !== pending) {
        this.releaseElement(pending);
        return;
      }

      element.preload = "auto";
      if (pending.settled || this.current !== pending) {
        this.releaseDetachedElement(element);
        return;
      }

      const priorSinkOperation = this.elementSinkOperations.get(elementSetupKey);
      if (priorSinkOperation !== undefined) {
        const priorSinkOutcome = await waitForBrowserOperationOrSettlement(
          priorSinkOperation,
          pending.result
        );
        if (priorSinkOutcome.status === "SETTLED") {
          this.releaseDetachedElement(element);
          return;
        }
        if (pending.settled || this.current !== pending) {
          this.releaseDetachedElement(element);
          return;
        }
      }

      const explicitOutput = requiresExplicitOutputSelection(pending.request.outputDeviceId);
      const priorSinkState = this.elementSinkStates.get(elementSetupKey);
      const mustResetDefaultOutput = !explicitOutput
        && priorSinkState !== undefined
        && priorSinkState !== "";

      if (explicitOutput || mustResetDefaultOutput) {
        const setSinkId = element.setSinkId;
        if (pending.settled || this.current !== pending) {
          this.releaseDetachedElement(element);
          return;
        }
        if (typeof setSinkId !== "function") {
          throw new AudioInfrastructureError(
            "OUTPUT_DEVICE_UNSUPPORTED",
            explicitOutput
              ? "Selecting an audio output device is not supported by this browser"
              : "Resetting a reused audio element to the default output is not supported"
          );
        }

        const requestedSinkId = explicitOutput ? pending.request.outputDeviceId : "";
        this.elementSinkStates.set(elementSetupKey, null);

        let sinkOperation: Promise<void>;
        try {
          sinkOperation = Promise.resolve(setSinkId.call(element, requestedSinkId));
        } catch (error) {
          if (pending.settled || this.current !== pending) {
            this.releaseDetachedElement(element);
            return;
          }
          throw mapOutputSelectionError(error);
        }

        let trackedSinkOperation: Promise<void>;
        trackedSinkOperation = sinkOperation.then(
          () => {
            if (this.elementSinkOperations.get(elementSetupKey) === trackedSinkOperation) {
              this.elementSinkStates.set(elementSetupKey, requestedSinkId);
            }
          },
          () => {
            if (this.elementSinkOperations.get(elementSetupKey) === trackedSinkOperation) {
              this.elementSinkStates.set(elementSetupKey, null);
            }
          }
        ).finally(() => {
          if (this.elementSinkOperations.get(elementSetupKey) === trackedSinkOperation) {
            this.elementSinkOperations.delete(elementSetupKey);
          }
        });
        this.elementSinkOperations.set(elementSetupKey, trackedSinkOperation);

        const sinkOutcome = await waitForBrowserOperationOrSettlement(
          sinkOperation,
          pending.result
        );
        if (sinkOutcome.status === "SETTLED") {
          this.releaseDetachedElement(element);
          return;
        }
        if (sinkOutcome.status === "REJECTED") {
          throw mapOutputSelectionError(sinkOutcome.error);
        }
      }

      if (pending.settled || this.current !== pending) {
        this.releaseDetachedElement(element);
        return;
      }

      const listeners = {
        playing: (): void => {
          if (pending.settled || pending.hasStarted || this.current !== pending) return;
          pending.hasStarted = true;
          pending.resolveStarted(true);
          void invoke(pending.request.callbacks?.onStarted).catch(() => undefined);
        },
        ended: (): void => {
          if (pending.settled || this.current !== pending) return;
          if (!pending.hasStarted) {
            this.failCurrent(
              pending,
              new AudioInfrastructureError(
                "PLAYBACK_FAILED",
                "Browser audio ended before playback started"
              )
            );
            return;
          }
          this.completeCurrent(pending);
        },
        error: (): void => {
          if (pending.settled || this.current !== pending) return;
          this.failCurrent(
            pending,
            new AudioInfrastructureError("PLAYBACK_FAILED", "Browser audio element reported a playback error")
          );
        }
      };
      pending.listeners = listeners;
      if (!this.attachCurrentListener(pending, element, "playing", listeners.playing)) return;
      if (!this.attachCurrentListener(pending, element, "ended", listeners.ended)) return;
      if (!this.attachCurrentListener(pending, element, "error", listeners.error)) return;

      if (pending.settled || this.current !== pending) {
        this.releaseDetachedElement(element);
        return;
      }

      element.src = pending.request.source;
      if (pending.settled || this.current !== pending) {
        this.releaseDetachedElement(element);
        return;
      }

      const play = element.play;
      if (pending.settled || this.current !== pending) {
        this.releaseDetachedElement(element);
        return;
      }
      if (typeof play !== "function") {
        throw new AudioInfrastructureError(
          "PLAYBACK_FAILED",
          "Browser audio element does not expose a callable play method"
        );
      }
      let playOperation: Promise<void>;
      try {
        playOperation = play.call(element);
      } catch (error) {
        if (pending.settled || this.current !== pending) {
          this.releaseDetachedElement(element);
          return;
        }
        throw error;
      }

      const playOutcome = await waitForBrowserOperationOrSettlement(
        playOperation,
        pending.result
      );
      if (playOutcome.status === "SETTLED") {
        this.releaseDetachedElement(element);
        return;
      }
      if (playOutcome.status === "REJECTED") {
        throw playOutcome.error;
      }

      if (pending.settled || this.current !== pending) {
        this.releaseDetachedElement(element);
        return;
      }
    } catch (error) {
      if (pending.settled || this.current !== pending) {
        if (
          element !== undefined
          && (
            elementSetupKey === undefined
            || this.elementSetupOwners.get(elementSetupKey) === pending
          )
        ) {
          this.releaseDetachedElement(element);
        }
        return;
      }
      const mapped = error instanceof AudioInfrastructureError
        ? error
        : mapPlaybackStartError(error);
      this.failCurrent(pending, mapped);
    } finally {
      if (
        elementSetupKey !== undefined
        && this.elementSetupOwners.get(elementSetupKey) === pending
      ) {
        this.elementSetupOwners.delete(elementSetupKey);
      }
    }
  }

  private attachCurrentListener(
    pending: PendingPlayback,
    element: BrowserAudioElementLike,
    type: "playing" | "ended" | "error",
    listener: () => void
  ): boolean {
    let addEventListener: BrowserAudioElementLike["addEventListener"];
    try {
      addEventListener = element.addEventListener;
      if (pending.removeEventListener === undefined) {
        const removeEventListener = element.removeEventListener;
        if (typeof removeEventListener !== "function") {
          throw new AudioInfrastructureError(
            "PLAYBACK_FAILED",
            "Browser audio element does not expose callable event listener removal"
          );
        }
        pending.removeEventListener = removeEventListener;
      }
    } catch (error) {
      if (pending.settled || this.current !== pending) {
        this.releaseDetachedElement(element);
        return false;
      }
      throw error;
    }

    if (pending.settled || this.current !== pending) {
      this.releaseDetachedElement(element);
      return false;
    }
    if (typeof addEventListener !== "function") {
      throw new AudioInfrastructureError(
        "PLAYBACK_FAILED",
        "Browser audio element does not expose callable event listener registration"
      );
    }

    try {
      addEventListener.call(element, type, listener);
    } catch (error) {
      if (pending.settled || this.current !== pending) {
        const removeEventListener = pending.removeEventListener;
        if (removeEventListener !== undefined) {
          safely(() => removeEventListener.call(element, type, listener));
        }
        this.releaseDetachedElement(element);
        return false;
      }
      throw error;
    }

    if (!pending.settled && this.current === pending) return true;

    const removeEventListener = pending.removeEventListener;
    if (removeEventListener !== undefined) {
      safely(() => removeEventListener.call(element, type, listener));
    }
    this.releaseDetachedElement(element);
    return false;
  }

  private completeCurrent(pending: PendingPlayback): void {
    if (!pending.hasStarted) {
      this.failCurrent(
        pending,
        new AudioInfrastructureError("PLAYBACK_FAILED", "Audio completed without a playing event")
      );
      return;
    }

    this.finishCurrent(
      pending,
      { id: pending.request.id, status: "COMPLETED" },
      pending.request.callbacks?.onCompleted
    );
  }

  private failCurrent(pending: PendingPlayback, error: AudioInfrastructureError): void {
    const onFailed = pending.request.callbacks?.onFailed;
    this.finishCurrent(
      pending,
      { id: pending.request.id, status: "FAILED", error },
      onFailed === undefined ? undefined : () => onFailed(error)
    );
  }

  private stopCurrent(status: "CANCELLED" | "INTERRUPTED"): void {
    const pending = this.current;
    if (pending === undefined || pending.settled) return;

    this.finishCurrent(
      pending,
      { id: pending.request.id, status },
      status === "CANCELLED"
        ? pending.request.callbacks?.onCancelled
        : pending.request.callbacks?.onInterrupted
    );
  }

  private finishCurrent(
    pending: PendingPlayback,
    outcome: AudioPlaybackOutcome,
    terminalCallback: (() => void | Promise<void>) | undefined
  ): void {
    if (this.current !== pending || pending.settled) return;

    this.resolve(pending, outcome);
    this.releaseElement(pending);
    this.current = undefined;
    void invoke(terminalCallback).catch(() => undefined);
    this.drain();
  }

  private settleQueued(pending: PendingPlayback): void {
    if (pending.settled) return;
    this.resolve(pending, { id: pending.request.id, status: "CANCELLED" });
    void invoke(pending.request.callbacks?.onCancelled).catch(() => undefined);
  }

  private resolve(pending: PendingPlayback, outcome: AudioPlaybackOutcome): void {
    if (pending.settled) return;
    this.recordAdmissionMutation(pending.request.id);
    pending.settled = true;
    if (!pending.hasStarted) pending.resolveStarted(false);
    pending.resolveResult(outcome);
  }

  private releaseDetachedElement(element: BrowserAudioElementLike, shouldPause = true): void {
    if (shouldPause) safely(() => element.pause());
    let sourceAttributeRemoved = false;
    try {
      const removeAttribute = element.removeAttribute;
      if (removeAttribute !== undefined) {
        removeAttribute.call(element, "src");
        sourceAttributeRemoved = true;
      }
    } catch {
      // Fall through to direct source clearing.
    }
    if (!sourceAttributeRemoved) {
      safely(() => {
        element.src = "";
      });
    }
    safely(() => {
      element.currentTime = 0;
    });
    safely(() => element.load());
  }

  private releaseElement(pending: PendingPlayback): void {
    const element = pending.element;
    const listeners = pending.listeners;
    const removeEventListener = pending.removeEventListener;
    const pause = pending.pause;
    pending.listeners = undefined;
    pending.removeEventListener = undefined;
    pending.pause = undefined;
    pending.element = undefined;
    if (element === undefined) return;

    if (listeners !== undefined && removeEventListener !== undefined) {
      safely(() => removeEventListener.call(element, "playing", listeners.playing));
      safely(() => removeEventListener.call(element, "ended", listeners.ended));
      safely(() => removeEventListener.call(element, "error", listeners.error));
    }

    if (pause !== undefined) {
      safely(() => pause.call(element));
      this.releaseDetachedElement(element, false);
    } else {
      this.releaseDetachedElement(element);
    }
  }

  private recordAdmissionMutation(id: string): void {
    for (const scope of this.admissionMutationScopes) {
      scope.add(id);
    }
  }

  private assertAdmissionIdUnchanged(mutatedIds: ReadonlySet<string>, id: string): void {
    if (!mutatedIds.has(id)) return;
    throw new AudioInfrastructureError(
      "CANCELLED",
      "Audio playback identity changed during request admission"
    );
  }

  private assertAdmissionNotCancelled(id: string): void {
    if (this.cancelledAdmittingIds.has(id)) {
      throw new AudioInfrastructureError(
        "CANCELLED",
        "Audio playback request was cancelled during admission"
      );
    }
  }

  private assertAdmissionUnchanged(epoch: number): void {
    if (this.admissionEpoch !== epoch) {
      throw new AudioInfrastructureError(
        "CANCELLED",
        "Audio playback admission was invalidated by queue cancellation"
      );
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new AudioInfrastructureError("DISPOSED", "Audio playback has been disposed");
    }
    if (this.cancellingAll || this.clearingQueued) {
      throw new AudioInfrastructureError(
        "CANCELLED",
        "Audio playback admission is closed while cancelling queued work"
      );
    }
  }
}

function validatePlayableAudioIdentity(request: Pick<PlayableAudio, "id">): void {
  if (typeof request.id !== "string" || request.id.trim().length === 0) {
    throw new AudioInfrastructureError("INVALID_REQUEST", "Audio playback id must be a non-blank string");
  }
}

function validatePlayableAudioPayload(request: PlayableAudio): void {
  if (typeof request.source !== "string" || request.source.trim().length === 0) {
    throw new AudioInfrastructureError("INVALID_REQUEST", "Audio playback source must be a non-blank string");
  }
  if (request.outputDeviceId !== undefined) {
    if (typeof request.outputDeviceId !== "string") {
      throw new AudioInfrastructureError(
        "INVALID_REQUEST",
        "Audio playback output device id must be a string"
      );
    }
    if (
      request.outputDeviceId.length > 0
      && request.outputDeviceId.trim().length === 0
    ) {
      throw new AudioInfrastructureError(
        "INVALID_REQUEST",
        "Audio playback output device id must not be whitespace-only"
      );
    }
  }
  if (request.callbacks !== undefined) {
    if (
      typeof request.callbacks !== "object"
      || request.callbacks === null
      || Array.isArray(request.callbacks)
    ) {
      throw new AudioInfrastructureError(
        "INVALID_REQUEST",
        "Audio playback callbacks must be a callback object"
      );
    }
    for (const [name, callback] of Object.entries(request.callbacks)) {
      if (!PLAYBACK_CALLBACK_NAMES.has(name)) {
        throw new AudioInfrastructureError(
          "INVALID_REQUEST",
          `Unknown audio playback callback ${name}`
        );
      }
      if (callback !== undefined && typeof callback !== "function") {
        throw new AudioInfrastructureError(
          "INVALID_REQUEST",
          `Audio playback callback ${name} must be callable`
        );
      }
    }
  }
}

function snapshotPlayableAudioIdentity(request: PlayableAudio): Pick<PlayableAudio, "id"> {
  return { id: request.id };
}

function snapshotPlayableAudioPayload(request: PlayableAudio, id: string): PlayableAudio {
  const source = request.source;
  const outputDeviceId = request.outputDeviceId;
  const requestCallbacks = request.callbacks;
  let callbacks: { readonly callbacks?: BrowserAudioPlaybackCallbacks } = {};
  if (requestCallbacks !== undefined) {
    if (
      typeof requestCallbacks !== "object"
      || requestCallbacks === null
      || Array.isArray(requestCallbacks)
    ) {
      throw new AudioInfrastructureError(
        "INVALID_REQUEST",
        "Audio playback callbacks must be a callback object"
      );
    }

    for (const name of Object.keys(requestCallbacks)) {
      if (!PLAYBACK_CALLBACK_NAMES.has(name)) {
        throw new AudioInfrastructureError(
          "INVALID_REQUEST",
          `Unknown audio playback callback ${name}`
        );
      }
    }
    callbacks = { callbacks: snapshotPlaybackCallbacks(requestCallbacks) };
  }
  const outputDevice = outputDeviceId === undefined
    ? {}
    : { outputDeviceId };

  return {
    id,
    source,
    ...outputDevice,
    ...callbacks
  };
}

function snapshotPlaybackCallbacks(
  callbacks: BrowserAudioPlaybackCallbacks
): BrowserAudioPlaybackCallbacks {
  const onStarted = callbacks.onStarted;
  const onCompleted = callbacks.onCompleted;
  const onCancelled = callbacks.onCancelled;
  const onInterrupted = callbacks.onInterrupted;
  const onFailed = callbacks.onFailed;

  return {
    ...(onStarted === undefined ? {} : { onStarted }),
    ...(onCompleted === undefined ? {} : { onCompleted }),
    ...(onCancelled === undefined ? {} : { onCancelled }),
    ...(onInterrupted === undefined ? {} : { onInterrupted }),
    ...(onFailed === undefined ? {} : { onFailed })
  };
}

function defaultAudioElement(): BrowserAudioElementLike {
  let AudioConstructor: typeof globalThis.Audio;
  try {
    AudioConstructor = globalThis.Audio;
  } catch (error) {
    throw new AudioInfrastructureError(
      "UNSUPPORTED",
      "HTML audio playback capability could not be read",
      { cause: error }
    );
  }
  if (typeof AudioConstructor !== "function") {
    throw new AudioInfrastructureError("UNSUPPORTED", "HTML audio playback is unavailable");
  }
  return new AudioConstructor();
}

function requiresExplicitOutputSelection(deviceId: string | undefined): deviceId is string {
  return deviceId !== undefined && deviceId !== "" && deviceId !== "default";
}

type BrowserOperationOutcome =
  | { readonly status: "RESOLVED" }
  | { readonly status: "REJECTED"; readonly error: unknown }
  | { readonly status: "SETTLED" };

async function waitForBrowserOperationOrSettlement(
  operation: PromiseLike<void>,
  settlement: Promise<AudioPlaybackOutcome>
): Promise<BrowserOperationOutcome> {
  const operationOutcome = Promise.resolve(operation).then<
    BrowserOperationOutcome,
    BrowserOperationOutcome
  >(
    () => ({ status: "RESOLVED" }),
    (error: unknown) => ({ status: "REJECTED", error })
  );
  const settlementOutcome = settlement.then<BrowserOperationOutcome>(
    () => ({ status: "SETTLED" })
  );
  return Promise.race([operationOutcome, settlementOutcome]);
}

function mapPlaybackStartError(error: unknown): AudioInfrastructureError {
  const name = errorName(error);
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new AudioInfrastructureError("PERMISSION_DENIED", "Audio playback was not permitted", {
      cause: error
    });
  }
  return new AudioInfrastructureError("PLAYBACK_FAILED", "Audio playback did not start", { cause: error });
}

function mapOutputSelectionError(error: unknown): AudioInfrastructureError {
  if (error instanceof AudioInfrastructureError) return error;

  const name = errorName(error);
  if (name === "NotFoundError") {
    return new AudioInfrastructureError("DEVICE_UNAVAILABLE", "Requested audio output device is unavailable", {
      cause: error
    });
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new AudioInfrastructureError("PERMISSION_DENIED", "Audio output device selection was not permitted", {
      cause: error
    });
  }

  return new AudioInfrastructureError("PLAYBACK_FAILED", "Audio output device selection failed", { cause: error });
}

function safely(operation: () => void): void {
  try {
    operation();
  } catch {
    // Teardown is best-effort and must continue through independent cleanup operations.
  }
}

async function invoke(callback: (() => void | Promise<void>) | undefined): Promise<void> {
  if (callback === undefined) return;
  await callback();
}

function errorName(error: unknown): string {
  try {
    if (typeof error !== "object" || error === null || !("name" in error)) return "";
    return String(Reflect.get(error, "name"));
  } catch {
    return "";
  }
}
