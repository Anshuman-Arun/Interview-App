const rawTypedArrayPrototype: unknown = Object.getPrototypeOf(Uint8Array.prototype);
if (typeof rawTypedArrayPrototype !== "object" || rawTypedArrayPrototype === null) {
  throw new Error("TypedArray prototype is unavailable");
}

const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  rawTypedArrayPrototype,
  "byteLength"
)?.get;

if (typedArrayByteLengthGetter === undefined) {
  throw new Error("TypedArray byteLength intrinsic is unavailable");
}

export function actualUint8ArrayByteLength(value: Uint8Array): number {
  const result: unknown = Reflect.apply(typedArrayByteLengthGetter, value, []);
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("TypedArray intrinsic returned an invalid byte length");
  }
  return result;
}
