interface SeededRandomCheckpoint {
  readonly state: number;
  readonly draws: number;
}

/** Deterministic PRNG for interview simulations. Do not use for cryptographic work. */
export class SeededRandom {
  private state: number;
  private drawsValue = 0;

  public constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) {
      throw new Error("Seed must be a safe integer");
    }
    this.state = seed >>> 0;
  }

  public get drawCount(): number {
    return this.drawsValue;
  }

  /** @internal Transaction rollback support for deterministic simulations. */
  public checkpoint(): SeededRandomCheckpoint {
    return { state: this.state, draws: this.drawsValue };
  }

  /** @internal Transaction rollback support for deterministic simulations. */
  public restore(checkpoint: SeededRandomCheckpoint): void {
    if (
      !Number.isSafeInteger(checkpoint.state)
      || checkpoint.state < 0
      || checkpoint.state > 0xffff_ffff
      || !Number.isSafeInteger(checkpoint.draws)
      || checkpoint.draws < 0
    ) {
      throw new Error("Invalid deterministic random checkpoint");
    }
    this.state = checkpoint.state;
    this.drawsValue = checkpoint.draws;
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    value = (value ^ (value >>> 14)) >>> 0;
    this.drawsValue += 1;
    return value / 4_294_967_296;
  }
}
