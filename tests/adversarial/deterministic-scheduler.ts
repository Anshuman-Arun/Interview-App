export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new Error("Failed to initialize deterministic deferred promise");
  }
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}

interface ScheduledTask<T> {
  readonly label: string;
  readonly gate: Deferred<undefined>;
  readonly completion: Promise<T | undefined>;
  released: boolean;
  cancelled: boolean;
}

export class DeterministicScheduler {
  private readonly tasks = new Map<string, ScheduledTask<unknown>>();

  public schedule<T>(label: string, operation: () => Promise<T> | T): void {
    if (label.trim().length === 0) throw new Error("Scheduled callback label must be non-empty");
    if (this.tasks.has(label)) throw new Error(`Scheduled callback already exists: ${label}`);

    const gate = deferred<undefined>();
    const task: ScheduledTask<T> = {
      label,
      gate,
      released: false,
      cancelled: false,
      completion: Promise.resolve(undefined)
    };
    const completion = gate.promise.then(async () => {
      if (task.cancelled) return undefined;
      return operation();
    });
    const stored: ScheduledTask<T> = {
      ...task,
      completion
    };
    this.tasks.set(label, stored);
  }

  public has(label: string): boolean {
    return this.tasks.has(label);
  }

  public isReleased(label: string): boolean {
    return this.requireTask(label).released;
  }

  public pendingLabels(): readonly string[] {
    return Array.from(this.tasks.values())
      .filter((task) => !task.released && !task.cancelled)
      .map((task) => task.label)
      .sort();
  }

  public release(label: string): void {
    const task = this.requireTask(label);
    if (task.cancelled) throw new Error(`Scheduled callback was cancelled: ${label}`);
    if (task.released) return;
    task.released = true;
    task.gate.resolve(undefined);
  }

  public async settle<T>(label: string): Promise<T> {
    const task = this.requireTask(label);
    if (!task.released) throw new Error(`Scheduled callback has not been released: ${label}`);
    const value = await task.completion;
    if (value === undefined && task.cancelled) {
      throw new Error(`Scheduled callback was cancelled before settlement: ${label}`);
    }
    return value as T;
  }

  public async releaseAndSettle<T>(label: string): Promise<T> {
    this.release(label);
    return this.settle<T>(label);
  }

  public async cancelPendingAndDrain(): Promise<void> {
    for (const task of this.tasks.values()) {
      if (!task.released) {
        task.cancelled = true;
        task.gate.resolve(undefined);
      }
    }
    await Promise.allSettled(Array.from(this.tasks.values(), (task) => task.completion));
  }

  private requireTask(label: string): ScheduledTask<unknown> {
    const task = this.tasks.get(label);
    if (task === undefined) throw new Error(`Unknown scheduled callback: ${label}`);
    return task;
  }
}
