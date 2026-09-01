import { isProxy } from "node:util/types";

const rawTypedArrayPrototype: unknown = Object.getPrototypeOf(Uint8Array.prototype);
if (typeof rawTypedArrayPrototype !== "object" || rawTypedArrayPrototype === null) {
  throw new Error("TypedArray prototype is unavailable");
}

function readTypedArrayByteLength(value: Uint8Array): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(
    rawTypedArrayPrototype,
    "byteLength"
  );
  if (typeof descriptor?.get !== "function") {
    throw new Error("TypedArray byteLength intrinsic is unavailable");
  }
  return descriptor.get.call(value);
}

export function actualUint8ArrayByteLength(value: Uint8Array): number {
  let result: unknown;
  try {
    result = readTypedArrayByteLength(value);
  } catch {
    throw new TypeError("Value is not a direct readable Uint8Array");
  }
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("TypedArray intrinsic returned an invalid byte length");
  }
  return result;
}

export function isDirectUint8Array(value: unknown): value is Uint8Array {
  if (typeof value !== "object" || value === null || isProxy(value)) return false;
  try {
    if (!(value instanceof Uint8Array)) return false;
    actualUint8ArrayByteLength(value);
    return true;
  } catch {
    return false;
  }
}
