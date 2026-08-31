export function boundedArrayLength(value: unknown, maximum: number, label: string): number {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new TypeError(`${label} could not be inspected safely`);
  }
  if (!isArray) throw new TypeError(`${label} must be an array`);
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


export function readArrayEntry<T>(value: readonly T[], index: number, label: string): T | undefined {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("Array index must be a nonnegative safe integer");
  }
  try {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return undefined;
    return value[index];
  } catch {
    throw new TypeError(`${label} entry ${String(index)} could not be read safely`);
  }
}
