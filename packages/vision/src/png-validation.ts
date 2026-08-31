import { crc32 } from "node:zlib";

const PNG_SIGNATURE_LENGTH = 8;
const HARD_MAX_PNG_CHUNKS = 4096;
const UNSUPPORTED_APNG_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);
const UNSUPPORTED_RENDERING_METADATA_CHUNKS = new Set([
  "cHRM",
  "iCCP",
  "sRGB",
  "sBIT",
  "bKGD"
]);
const KNOWN_CRITICAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);

const SUPPORTED_PNG_BIT_DEPTHS = new Map<number, ReadonlySet<number>>([
  [0, new Set([1, 2, 4, 8])],
  [2, new Set([8])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8])],
  [6, new Set([8])]
]);

function isAsciiLetter(value: number): boolean {
  return (value >= 65 && value <= 90) || (value >= 97 && value <= 122);
}

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

export function assertStaticPngChunkStructure(bytes: Buffer): void {
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  if (bitDepth === undefined || colorType === undefined) {
    throw new RangeError("PNG IHDR is truncated");
  }

  let offset = PNG_SIGNATURE_LENGTH;
  let chunkIndex = 0;
  let foundEnd = false;
  let seenPalette = false;
  let paletteEntries = 0;
  let seenTransparency = false;
  let seenGamma = false;
  let seenImageData = false;
  let imageDataEnded = false;

  while (offset < bytes.length) {
    if (chunkIndex >= HARD_MAX_PNG_CHUNKS) {
      throw new RangeError("PNG contains too many chunks for bounded preprocessing");
    }
    if (offset + 12 > bytes.length) throw new RangeError("PNG contains a truncated chunk");

    const chunkLength = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const nextOffset = dataEnd + 4;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.length) {
      throw new RangeError("PNG chunk length exceeds encoded payload bounds");
    }

    for (let index = typeStart; index < dataStart; index += 1) {
      const value = bytes[index];
      if (value === undefined || !isAsciiLetter(value)) {
        throw new RangeError("PNG chunk type contains a non-letter byte");
      }
    }
    const reservedByte = bytes[typeStart + 2];
    if (reservedByte === undefined || (reservedByte & 0x20) !== 0) {
      throw new RangeError("PNG chunk type uses the reserved lowercase bit");
    }

    const chunkType = bytes.toString("ascii", typeStart, dataStart);
    const storedCrc = bytes.readUInt32BE(dataEnd);
    const computedCrc = crc32(bytes.subarray(typeStart, dataEnd)) >>> 0;
    if (storedCrc !== computedCrc) {
      throw new RangeError("PNG chunk CRC validation failed");
    }

    if (chunkIndex === 0 && (chunkType !== "IHDR" || chunkLength !== 13)) {
      throw new RangeError("PNG must begin with exactly one IHDR chunk");
    }
    if (chunkIndex > 0 && chunkType === "IHDR") {
      throw new RangeError("PNG contains multiple IHDR chunks");
    }
    if (UNSUPPORTED_APNG_CHUNKS.has(chunkType)) {
      throw new RangeError("Animated PNG chunks are unsupported");
    }
    if (UNSUPPORTED_RENDERING_METADATA_CHUNKS.has(chunkType)) {
      throw new RangeError(
        "PNG rendering metadata unsupported by the preprocessing codec is not accepted"
      );
    }

    if (seenImageData && chunkType !== "IDAT" && chunkType !== "IEND") {
      imageDataEnded = true;
    }

    if (chunkType === "PLTE") {
      if (seenPalette || seenTransparency || seenImageData) {
        throw new RangeError("PNG palette must appear at most once before image data");
      }
      if (colorType === 0 || colorType === 4) {
        throw new RangeError("PNG grayscale color types may not contain a palette");
      }
      if (chunkLength === 0 || chunkLength > 768 || chunkLength % 3 !== 0) {
        throw new RangeError("PNG palette must contain between 1 and 256 RGB entries");
      }
      paletteEntries = chunkLength / 3;
      if (colorType === 3 && paletteEntries > 2 ** bitDepth) {
        throw new RangeError("Indexed PNG palette exceeds the bit-depth entry limit");
      }
      seenPalette = true;
    } else if (chunkType === "tRNS") {
      if (seenTransparency || seenImageData) {
        throw new RangeError("PNG transparency chunk must appear at most once before image data");
      }
      if (colorType === 0) {
        if (chunkLength !== 2) {
          throw new RangeError("Grayscale PNG transparency chunk must contain one sample");
        }
        if (bytes.readUInt16BE(dataStart) >= 2 ** bitDepth) {
          throw new RangeError("Grayscale PNG transparency sample exceeds the bit-depth range");
        }
      }
      if (colorType === 2) {
        if (chunkLength !== 6) {
          throw new RangeError("RGB PNG transparency chunk must contain three samples");
        }
        for (let sampleOffset = 0; sampleOffset < 6; sampleOffset += 2) {
          if (bytes.readUInt16BE(dataStart + sampleOffset) >= 2 ** bitDepth) {
            throw new RangeError("RGB PNG transparency sample exceeds the bit-depth range");
          }
        }
      }
      if (colorType === 3) {
        if (!seenPalette || chunkLength === 0 || chunkLength > paletteEntries) {
          throw new RangeError("Indexed PNG transparency must follow and fit its palette");
        }
      }
      if (colorType === 4 || colorType === 6) {
        throw new RangeError("PNG color types with alpha may not contain a transparency chunk");
      }
      seenTransparency = true;
    } else if (chunkType === "gAMA") {
      if (seenGamma || seenPalette || seenImageData || chunkLength !== 4) {
        throw new RangeError("PNG gamma chunk must appear once before palette/image data and contain four bytes");
      }
      if (bytes.readUInt32BE(dataStart) === 0) {
        throw new RangeError("PNG gamma value must be nonzero");
      }
      seenGamma = true;
    } else if (chunkType === "IDAT") {
      if (imageDataEnded) {
        throw new RangeError("PNG image-data chunks must be consecutive");
      }
      if (colorType === 3 && !seenPalette) {
        throw new RangeError("Indexed PNG requires a palette before image data");
      }
      seenImageData = true;
    } else if (chunkType === "IEND") {
      if (chunkLength !== 0) throw new RangeError("PNG IEND chunk must be empty");
      if (!seenImageData) throw new RangeError("PNG must contain image data before IEND");
      if (nextOffset !== bytes.length) throw new RangeError("PNG contains trailing bytes after IEND");
      foundEnd = true;
      break;
    } else {
      const firstTypeByte = bytes[typeStart];
      if (firstTypeByte === undefined) throw new RangeError("PNG chunk type is missing");
      const ancillary = (firstTypeByte & 0x20) !== 0;
      if (!ancillary && !KNOWN_CRITICAL_CHUNKS.has(chunkType)) {
        throw new RangeError("PNG contains an unsupported critical chunk");
      }
    }

    offset = nextOffset;
    chunkIndex += 1;
  }

  if (!foundEnd) throw new RangeError("PNG is missing its terminal IEND chunk");
}
