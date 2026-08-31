const SUPPORTED_PNG_BIT_DEPTHS = new Map<number, ReadonlySet<number>>([
  [0, new Set([1, 2, 4, 8])],
  [2, new Set([8])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8])],
  [6, new Set([8])]
]);

export function assertSupportedPngHeaderParameters(bytes: Buffer): void {
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compressionMethod = bytes[26];
  const filterMethod = bytes[27];
  const interlaceMethod = bytes[28];
  if (bitDepth === undefined
      || colorType === undefined
      || compressionMethod === undefined
      || filterMethod === undefined
      || interlaceMethod === undefined) {
    throw new RangeError("PNG IHDR is truncated");
  }
  if (compressionMethod !== 0 || filterMethod !== 0) {
    throw new RangeError("PNG uses an unsupported compression or filter method");
  }
  if (interlaceMethod !== 0) {
    throw new RangeError("Interlaced PNG payloads are unsupported for bounded preprocessing");
  }
  if (SUPPORTED_PNG_BIT_DEPTHS.get(colorType)?.has(bitDepth) !== true) {
    throw new RangeError("PNG color type or bit depth is unsupported for bounded preprocessing");
  }
}
