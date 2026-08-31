export function boundedArrayLength(value: unknown, maximum: number, label: string): number {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new RangeError("Array maximum must be a nonnegative safe integer");
  }

  const rawLength: unknown = Reflect.get(value, "length");
  if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) {
    throw new TypeError(`${label} length must be a nonnegative safe integer`);
  }
  if (rawLength > maximum) {
    throw new RangeError(`${label} accepts at most ${String(maximum)} entries`);
  }
  return rawLength;
}
