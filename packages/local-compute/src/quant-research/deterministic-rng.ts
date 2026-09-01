export class DeterministicRng {
  #state: number;

  public constructor(seed: number, namespace: string) {
    let mixed = seed >>> 0;
    for (let index = 0; index < namespace.length; index += 1) {
      mixed ^= namespace.charCodeAt(index);
      mixed = Math.imul(mixed, 0x45d9f3b) >>> 0;
      mixed ^= mixed >>> 16;
    }
    this.#state = mixed === 0 ? 0x6d2b79f5 : mixed;
  }

  public nextUint32(): number {
    let value = this.#state >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.#state = value >>> 0;
    return this.#state;
  }

  public nextInt(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) throw new Error("Invalid deterministic RNG bounds");
    const width = max - min + 1;
    if (width <= 0 || width > 0x1_0000_0000) throw new Error("Deterministic RNG width is out of range");
    const limit = Math.floor(0x1_0000_0000 / width) * width;
    let draw = this.nextUint32();
    while (draw >= limit) draw = this.nextUint32();
    return min + (draw % width);
  }

  public shuffle<T>(input: readonly T[]): T[] {
    const output = [...input];
    for (let index = output.length - 1; index > 0; index -= 1) {
      const target = this.nextInt(0, index);
      const left = output[index];
      const right = output[target];
      if (left !== undefined && right !== undefined) {
        output[index] = right;
        output[target] = left;
      }
    }
    return output;
  }
}
