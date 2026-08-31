export function boundedArrayLength(value: unknown, maximum: number, label: string): number {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new RangeError("Array maximum must be a nonnegative safe integer");
  }

  let rawLength: unknown;
  try {
    rawLength = Reflect.get(value, "length");
  } catch {
    throw new TypeError(`${label} length could not be read safely`);
  }
  if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) {
    throw new TypeError(`${label} length must be a nonnegative safe integer`);
  }
  if (rawLength > maximum) {
    throw new RangeError(`${label} accepts at most ${String(maximum)} entries`);
  }
  return rawLength;
}


export function readArrayEntry(value: readonly unknown[], index: number, label: string): unknown {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("Array index must be a nonnegative safe integer");
  }
  try {
    return Reflect.get(value, String(index));
  } catch {
    throw new TypeError(`${label} entry ${String(index)} could not be read safely`);
  }
}
