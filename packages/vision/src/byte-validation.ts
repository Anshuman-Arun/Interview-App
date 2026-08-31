const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength"
)?.get;

if (typedArrayByteLengthGetter === undefined) {
  throw new Error("TypedArray byteLength intrinsic is unavailable");
}

export function actualUint8ArrayByteLength(value: Uint8Array): number {
  return Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
}
