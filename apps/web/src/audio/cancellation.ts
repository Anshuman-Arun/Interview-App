import { AudioInfrastructureError } from "./types.js";

export class AudioCancellationController {
  private readonly controller = new AbortController();
  private cancellationError: AudioInfrastructureError | undefined;

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  public cancel(reason = "Audio work cancelled"): void {
    if (this.controller.signal.aborted) return;
    const error = new AudioInfrastructureError("CANCELLED", reason);
    this.cancellationError = error;
    this.controller.abort(error);
  }

  public throwIfCancelled(): void {
    if (!this.controller.signal.aborted) return;
    throw this.cancellationError ?? new AudioInfrastructureError("CANCELLED", "Audio work cancelled");
  }
}
