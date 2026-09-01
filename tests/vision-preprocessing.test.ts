import { crc32, deflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { BoardRevisionSchema } from "../packages/domain/src/index.js";
import {
  INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION,
  INTERNAL_VISION_ARTIFACT_CONSTRUCTION
} from "../packages/vision/src/internal-artifact-construction.js";
import {
  ArtifactSourceBoundsSchema,
  DirtyRegionInputSchema,
  HARD_IMAGE_VALIDATION_LIMITS,
  ImageRectSchema,
  ImagePayloadReferenceMetadataSchema,
  ImageSnapshot,
  ImageSnapshotInputSchema,
  ImageSnapshotMetadataSchema,
  VisionImageArtifact,
  VisionImageArtifactMetadataSchema,
  VisionPreprocessingError,
  VisionProcessingDiagnosticsSchema,
  assertRectWithinImage,
  clipRectToBounds,
  coalesceOverlappingRegions,
  createValidatedImageSnapshot,
  createVisionProcessingDiagnostics,
  cropImage,
  cropPayloadKey,
  deduplicateExactImagePayloads,
  downscaleImage,
  exactImagePayloadDuplicate,
  expandRect,
  imageBounds,
  intersectRects,
  isCropOrTileArtifact,
  normalizeRect,
  planDirtyRegions,
  planDownscale,
  planImageTiles,
  prepareVisionBatch,
  prepareVisionImageRequest,
  rectArea,
  rectContains,
  rectsOverlap,
  rasterizeDirtyRegion,
  requestPayloadIsSafeReference,
  revisionImageProcessingKey,
  sameRevisionAndImage,
  sha256ImageBytes,
  tileImage,
  unionRects,
  validateImageRect
} from "../packages/vision/src/index.js";

function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number] = (x, y) => [x % 256, y % 256, (x + y) % 256, 255]
): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const values = pixel(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = values[0];
      data[offset + 1] = values[1];
      data[offset + 2] = values[2];
      data[offset + 3] = values[3];
    }
  }
  return PNG.sync.write({ width, height, data }, { colorType: 6, inputColorType: 6, bitDepth: 8 });
}

function makePngChunk(type: string, data: Uint8Array = new Uint8Array()): Buffer {
  if (!/^[A-Za-z]{4}$/u.test(type)) throw new Error("PNG chunk type must contain four ASCII letters");
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.from(data);
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  typeBytes.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])) >>> 0, 8 + payload.length);
  return chunk;
}

function makeMinimalPng(
  colorType: 0 | 2 | 3 | 4 | 6,
  pixelBytes: readonly number[],
  options: {
    readonly bitDepth?: 1 | 2 | 4 | 8;
    readonly palette?: readonly number[];
    readonly transparency?: readonly number[];
  } = {}
): Buffer {
  const bitDepth = options.bitDepth ?? 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const chunks: Buffer[] = [makePngChunk("IHDR", ihdr)];
  if (options.palette !== undefined) {
    chunks.push(makePngChunk("PLTE", Buffer.from(options.palette)));
  }
  if (options.transparency !== undefined) {
    chunks.push(makePngChunk("tRNS", Buffer.from(options.transparency)));
  }
  chunks.push(makePngChunk("IDAT", deflateSync(Buffer.from([0, ...pixelBytes]))));
  chunks.push(makePngChunk("IEND"));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks
  ]);
}

function insertAfterIhdr(base: Buffer, ...chunks: readonly Buffer[]): Buffer {
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([
    base.subarray(0, ihdrEnd),
    ...chunks,
    base.subarray(ihdrEnd)
  ]);
}

function snapshot(
  bytes: Uint8Array,
  options: { readonly id?: string; readonly revision?: number; readonly declaredWidth?: number; readonly declaredHeight?: number } = {}
): ImageSnapshot {
  return createValidatedImageSnapshot({
    snapshotId: options.id ?? "snapshot-1",
    sourceType: "WHITEBOARD_SNAPSHOT",
    sourceRevision: BoardRevisionSchema.parse(options.revision ?? 3),
    capturedAtMs: 1234,
    captureSequence: 7,
    mimeType: "image/png" as const,
    ...(options.declaredWidth === undefined ? {} : { declaredWidth: options.declaredWidth }),
    ...(options.declaredHeight === undefined ? {} : { declaredHeight: options.declaredHeight }),
    encodedBytes: bytes
  });
}

function expectCode(error: unknown, code: VisionPreprocessingError["code"]): void {
  expect(error).toBeInstanceOf(VisionPreprocessingError);
  expect((error as VisionPreprocessingError).code).toBe(code);
}

function rgbaAt(bytes: Uint8Array, x: number, y: number): readonly number[] {
  const decoded = PNG.sync.read(Buffer.from(bytes));
  const offset = (y * decoded.width + x) * 4;
  return Array.from(decoded.data.subarray(offset, offset + 4));
}

describe("vision snapshot validation and hashing", () => {
  it("validates PNG bytes from the encoded image rather than trusting caller dimensions", () => {
    const bytes = makePng(5, 4);
    const value = snapshot(bytes, { declaredWidth: 5, declaredHeight: 4 });
    expect(value.metadata).toMatchObject({
      snapshotId: "snapshot-1",
      sourceRevision: 3,
      width: 5,
      height: 4,
      mimeType: "image/png" as const,
      encoding: "PNG",
      byteSize: bytes.length
    });
    expect(value.metadata.contentDigest).toBe(sha256ImageBytes(bytes));
    expect(JSON.stringify(value)).not.toContain(bytes.toString("base64"));
  });

  it("accepts every documented bounded PNG color type using generated fixtures", () => {
    const fixtures = [
      makeMinimalPng(0, [127]),
      makeMinimalPng(2, [10, 20, 30]),
      makeMinimalPng(3, [0], { palette: [10, 20, 30] }),
      makeMinimalPng(4, [127, 200]),
      makeMinimalPng(6, [10, 20, 30, 255]),
      makeMinimalPng(0, [0], { bitDepth: 1 }),
      makeMinimalPng(3, [0], { bitDepth: 1, palette: [10, 20, 30] })
    ];

    for (const bytes of fixtures) {
      const value = snapshot(bytes);
      expect(value.metadata).toMatchObject({
        width: 1,
        height: 1,
        mimeType: "image/png" as const,
        encoding: "PNG"
      });
      expect(value.metadata.contentDigest).toBe(sha256ImageBytes(bytes));
    }
  });

  it("accepts bounded valid transparency and gamma metadata", () => {
    const grayscaleWithTransparency = makeMinimalPng(0, [127], { transparency: [0, 127] });
    const transparencyTypeOffset = grayscaleWithTransparency.indexOf(Buffer.from("tRNS", "ascii"));
    if (transparencyTypeOffset < 4) throw new Error("Generated PNG unexpectedly lacks tRNS");
    const transparencyChunkStart = transparencyTypeOffset - 4;
    const transparencyChunkLength = grayscaleWithTransparency.readUInt32BE(transparencyChunkStart);
    const transparencyChunkEnd = transparencyChunkStart + 12 + transparencyChunkLength;
    const transparencyThenGamma = Buffer.concat([
      grayscaleWithTransparency.subarray(0, transparencyChunkEnd),
      makePngChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f])),
      grayscaleWithTransparency.subarray(transparencyChunkEnd)
    ]);

    const valid = [
      grayscaleWithTransparency,
      makeMinimalPng(2, [10, 20, 30], {
        transparency: [0, 10, 0, 20, 0, 30]
      }),
      makeMinimalPng(3, [0], {
        palette: [10, 20, 30],
        transparency: [128]
      }),
      insertAfterIhdr(
        makePng(1, 1),
        makePngChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f]))
      ),
      transparencyThenGamma
    ];

    for (const bytes of valid) {
      expect(snapshot(bytes).metadata.contentDigest).toBe(sha256ImageBytes(bytes));
    }
  });

  it("copies input bytes so caller mutation cannot invalidate the stored digest", () => {
    const bytes = makePng(2, 2);
    const originalDigest = sha256ImageBytes(bytes);
    const value = snapshot(bytes);
    bytes.fill(0);
    expect(value.metadata.contentDigest).toBe(originalDigest);
    expect(sha256ImageBytes(value.readBytes())).toBe(originalDigest);
  });

  it("rejects impossible declared dimensions and artifact source bounds at schema level", () => {
    expect(ImageSnapshotInputSchema.safeParse({
      snapshotId: "oversized-declaration",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      declaredWidth: HARD_IMAGE_VALIDATION_LIMITS.maxWidth + 1,
      encodedBytes: makePng(1, 1)
    }).success).toBe(false);

    expect(ImageSnapshotInputSchema.safeParse({
      snapshotId: "empty-image",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      encodedBytes: new Uint8Array()
    }).success).toBe(false);

    expect(ImageSnapshotInputSchema.safeParse({
      snapshotId: "unsupported-mime-schema",
      sourceType: "BROWSER_SCREENSHOT",
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/jpeg",
      encodedBytes: makePng(1, 1)
    }).success).toBe(false);

    expect(ArtifactSourceBoundsSchema.safeParse({
      x: HARD_IMAGE_VALIDATION_LIMITS.maxWidth - 1,
      y: 0,
      width: 2,
      height: 1
    }).success).toBe(false);

    expect(ArtifactSourceBoundsSchema.safeParse({
      x: 0,
      y: 0,
      width: 8192,
      height: 8193
    }).success).toBe(false);
  });

  it("makes exported geometry schemas reject unsafe derived edges directly", () => {
    expect(ImageRectSchema.safeParse({
      x: Number.MAX_SAFE_INTEGER,
      y: 0,
      width: 1,
      height: 1
    }).success).toBe(false);

    expect(DirtyRegionInputSchema.safeParse({
      x: Number.MAX_SAFE_INTEGER,
      y: 0,
      width: 1,
      height: 0
    }).success).toBe(false);
  });

  it("makes exported metadata schemas enforce package hard image caps directly", async () => {
    const source = snapshot(makePng(2, 2));
    const crop = (await cropImage(source, { x: 0, y: 0, width: 1, height: 1 })).artifact;
    const request = prepareVisionImageRequest(source, "schema-caps");

    expect(ImageSnapshotMetadataSchema.safeParse({
      ...source.metadata,
      width: HARD_IMAGE_VALIDATION_LIMITS.maxWidth + 1
    }).success).toBe(false);

    expect(ImageSnapshotMetadataSchema.safeParse({
      ...source.metadata,
      width: 8192,
      height: 8193
    }).success).toBe(false);

    expect(VisionImageArtifactMetadataSchema.safeParse({
      ...crop.metadata,
      byteSize: HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes + 1
    }).success).toBe(false);

    expect(ImagePayloadReferenceMetadataSchema.safeParse({
      ...request.payload.metadata,
      height: HARD_IMAGE_VALIDATION_LIMITS.maxHeight + 1
    }).success).toBe(false);
  });

  it("rejects artifact metadata whose deterministic ID is stale after provenance changes", async () => {
    const source = snapshot(makePng(4, 4));
    const crop = (await cropImage(source, { x: 1, y: 1, width: 2, height: 2 })).artifact;
    expect(() => new VisionImageArtifact(INTERNAL_VISION_ARTIFACT_CONSTRUCTION, source, {
      ...crop.metadata,
      sourceRevision: BoardRevisionSchema.parse(crop.metadata.sourceRevision + 1)
    }, crop.readBytes())).toThrowError(RangeError);
  });

  it("rejects impossible artifact kind/source-bound combinations", async () => {
    const source = snapshot(makePng(4, 4));
    const crop = (await cropImage(source, { x: 1, y: 1, width: 2, height: 2 })).artifact;
    expect(() => new VisionImageArtifact(INTERNAL_VISION_ARTIFACT_CONSTRUCTION, source, {
      ...crop.metadata,
      sourceBounds: { x: 1, y: 1, width: 3, height: 2 }
    }, crop.readBytes())).toThrow();

    expect(() => new VisionImageArtifact(INTERNAL_VISION_ARTIFACT_CONSTRUCTION, source, {
      ...crop.metadata,
      kind: "RESIZED",
      sourceBounds: { x: 0, y: 0, width: crop.metadata.width, height: crop.metadata.height }
    }, crop.readBytes())).toThrow();
  });

  it("rejects artifact construction against a different immediate source even when dimensions and revision match", async () => {
    const firstSource = snapshot(makePng(4, 4, () => [10, 10, 10, 255]), {
      id: "same-shape-a",
      revision: 12
    });
    const secondSource = snapshot(makePng(4, 4, () => [20, 20, 20, 255]), {
      id: "same-shape-b",
      revision: 12
    });
    const crop = (await cropImage(firstSource, { x: 1, y: 1, width: 2, height: 2 })).artifact;

    expect(() => new VisionImageArtifact(
      INTERNAL_VISION_ARTIFACT_CONSTRUCTION,
      secondSource,
      crop.metadata,
      crop.readBytes()
    )).toThrowError(RangeError);
  });

  it("rejects artifact construction without the package's internal capability", async () => {
    const source = snapshot(makePng(4, 4));
    const crop = (await cropImage(source, { x: 1, y: 1, width: 2, height: 2 })).artifact;
    const invalidToken = Symbol("not-the-package-token") as never;

    expect(() => new VisionImageArtifact(
      invalidToken,
      source,
      crop.metadata,
      crop.readBytes()
    )).toThrowError(RangeError);
  });

  it("rejects direct snapshot construction without the package admission capability", () => {
    const admitted = snapshot(makePng(2, 2));
    const invalidToken = Symbol("not-the-snapshot-token") as never;

    expect(() => new ImageSnapshot(
      invalidToken,
      admitted.metadata,
      admitted.readBytes()
    )).toThrowError(RangeError);
  });

  it("rejects forged metadata when public image containers are constructed directly", () => {
    const value = snapshot(makePng(2, 2));
    expect(() => new ImageSnapshot(INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION, {
      ...value.metadata,
      contentDigest: "0".repeat(64)
    }, value.readBytes())).toThrowError(RangeError);
    expect(() => new ImageSnapshot(INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION, {
      ...value.metadata,
      width: value.metadata.width + 1
    }, value.readBytes())).toThrowError(RangeError);
  });

  it("does not allow direct construction to bypass full PNG decoding", () => {
    const value = snapshot(makePng(2, 2));
    const truncated = value.readBytes().subarray(0, 29);
    expect(() => new ImageSnapshot(INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION, {
      ...value.metadata,
      byteSize: truncated.byteLength,
      contentDigest: sha256ImageBytes(truncated)
    }, truncated)).toThrowError(RangeError);
  });

  it("rejects CRC-corrupted PNG input after its cheap header checks pass", () => {
    const corrupted = Buffer.from(makePng(2, 2));
    const last = corrupted.length - 1;
    const value = corrupted[last];
    if (value === undefined) throw new Error("Generated PNG unexpectedly empty");
    corrupted[last] = value ^ 0xff;

    expect(() => snapshot(corrupted)).toThrowError(VisionPreprocessingError);
    try {
      snapshot(corrupted);
    } catch (error) {
      expectCode(error, "INVALID_IMAGE");
    }
  });

  it("freezes validated image identity metadata and the container itself", () => {
    const value = snapshot(makePng(2, 2));
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.metadata)).toBe(true);
  });

  it("rejects detached typed-array image payloads cleanly", () => {
    const bytes = new Uint8Array(makePng(1, 1));
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    expect(bytes.byteLength).toBe(0);

    try {
      createValidatedImageSnapshot({
        snapshotId: "detached-bytes",
        sourceType: "WHITEBOARD_SNAPSHOT",
        sourceRevision: BoardRevisionSchema.parse(1),
        capturedAtMs: 1,
        mimeType: "image/png" as const,
        encodedBytes: bytes
      });
      throw new Error("Expected detached byte rejection");
    } catch (error) {
      expectCode(error, "INVALID_IMAGE");
    }
  });

  it("rejects non-byte payloads at the runtime boundary", () => {
    expect(() => createValidatedImageSnapshot({
      snapshotId: "runtime-bad-bytes",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(0),
      capturedAtMs: 0,
      mimeType: "image/png" as const,
      encodedBytes: "not-bytes" as unknown as Uint8Array
    })).toThrowError(VisionPreprocessingError);
  });

  it("rejects proxied or revoked encoded byte payloads as invalid images", () => {
    const proxied = new Proxy(makePng(1, 1), {});
    const revoked = Proxy.revocable(makePng(1, 1), {});
    revoked.revoke();

    for (const encodedBytes of [proxied, revoked.proxy]) {
      try {
        createValidatedImageSnapshot({
          snapshotId: "proxied-bytes",
          sourceType: "WHITEBOARD_SNAPSHOT",
          sourceRevision: BoardRevisionSchema.parse(0),
          capturedAtMs: 0,
          mimeType: "image/png" as const,
          encodedBytes: encodedBytes as Uint8Array
        });
        throw new Error("Expected proxied byte rejection");
      } catch (error) {
        expectCode(error, "INVALID_IMAGE");
      }
    }
  });

  it("reports a PNG-signature prefix with a truncated header as INVALID_IMAGE, not MIME mismatch", () => {
    const truncated = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
    ]);
    try {
      snapshot(truncated);
      throw new Error("Expected truncated PNG rejection");
    } catch (error) {
      expectCode(error, "INVALID_IMAGE");
    }
  });

  it("rejects malformed bytes and detectable MIME mismatch", () => {
    expect(() => snapshot(Buffer.from("not-a-png"))).toThrowError(VisionPreprocessingError);
    try {
      snapshot(Buffer.from("not-a-png"));
    } catch (error) {
      expectCode(error, "MIME_MISMATCH");
    }

    const bytes = makePng(1, 1);
    try {
      createValidatedImageSnapshot({
        snapshotId: "bad-mime",
        sourceType: "BROWSER_SCREENSHOT",
        sourceRevision: BoardRevisionSchema.parse(0),
        capturedAtMs: 0,
        mimeType: "image/jpeg",
        encodedBytes: bytes
      } as unknown as Parameters<typeof createValidatedImageSnapshot>[0]);
      throw new Error("Expected unsupported MIME rejection");
    } catch (error) {
      expectCode(error, "UNSUPPORTED_IMAGE_TYPE");
    }
  });

  it("rejects oversized IHDR dimensions before full PNG decode", () => {
    const oversizedWidth = Buffer.from(makePng(1, 1));
    oversizedWidth.writeUInt32BE(9000, 16);
    try {
      snapshot(oversizedWidth);
      throw new Error("Expected oversized width rejection");
    } catch (error) {
      expectCode(error, "IMAGE_DIMENSIONS_EXCEEDED");
    }

    const oversizedPixels = Buffer.from(makePng(1, 1));
    oversizedPixels.writeUInt32BE(6000, 16);
    oversizedPixels.writeUInt32BE(6000, 20);
    try {
      snapshot(oversizedPixels);
      throw new Error("Expected oversized pixel-count rejection");
    } catch (error) {
      expectCode(error, "IMAGE_PIXELS_EXCEEDED");
    }
  });

  it("rejects unsafe board revisions before they can enter deterministic image identity", () => {
    const unsafeRevision = (Number.MAX_SAFE_INTEGER + 1) as ReturnType<typeof BoardRevisionSchema.parse>;
    expect(() => createValidatedImageSnapshot({
      snapshotId: "unsafe-revision",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: unsafeRevision,
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      encodedBytes: makePng(1, 1)
    })).toThrowError(VisionPreprocessingError);
  });

  it("bounds static PNG chunk walking against checksum-valid tiny-chunk CPU amplification", () => {
    const base = makePng(1, 1);
    const emptyChunk = makePngChunk("tEXt");
    const manyChunks = Array.from({ length: 4096 }, () => emptyChunk);
    const adversarial = insertAfterIhdr(base, ...manyChunks);

    expect(() => snapshot(adversarial)).toThrowError(VisionPreprocessingError);
  });

  it("rejects interlaced PNGs before entering the decoder's unbounded sync inflate path", () => {
    const interlaced = Buffer.from(makePng(2, 2));
    interlaced[28] = 1;
    expect(() => snapshot(interlaced)).toThrowError(VisionPreprocessingError);
    try {
      snapshot(interlaced);
    } catch (error) {
      expectCode(error, "INVALID_IMAGE");
    }
  });

  it("rejects trailing bytes after IEND and checksum-valid APNG control chunks", () => {
    const trailing = Buffer.concat([makePng(2, 2), Buffer.from([0xde, 0xad])]);
    expect(() => snapshot(trailing)).toThrowError(VisionPreprocessingError);

    const animated = insertAfterIhdr(
      makePng(2, 2),
      makePngChunk("acTL", Buffer.alloc(8))
    );
    expect(() => snapshot(animated)).toThrowError(VisionPreprocessingError);
  });

  it("rejects oversized, repeated, or forbidden palette chunks before pngjs allocation", () => {
    const rgba = makePng(1, 1);
    expect(() => snapshot(insertAfterIhdr(
      rgba,
      makePngChunk("PLTE", Buffer.alloc(771))
    ))).toThrowError(VisionPreprocessingError);

    const palette = makePngChunk("PLTE", Buffer.from([0, 0, 0]));
    expect(() => snapshot(insertAfterIhdr(
      rgba,
      palette,
      palette
    ))).toThrowError(VisionPreprocessingError);

    const grayscale = Buffer.from(makePng(1, 1));
    grayscale[25] = 0;
    const ihdrTypeAndData = grayscale.subarray(12, 29);
    grayscale.writeUInt32BE(crc32(ihdrTypeAndData) >>> 0, 29);
    expect(() => snapshot(insertAfterIhdr(
      grayscale,
      palette
    ))).toThrowError(VisionPreprocessingError);
  });

  it("rejects rendering/orientation metadata the codec cannot preserve, but accepts innocuous metadata", () => {
    const base = makePng(2, 2);
    for (const chunkType of ["cHRM", "iCCP", "sRGB", "sBIT", "bKGD", "eXIf", "cICP", "mDCv", "cLLi"]) {
      expect(() => snapshot(insertAfterIhdr(
        base,
        makePngChunk(chunkType, Buffer.alloc(chunkType === "sRGB" ? 1 : 4))
      ))).toThrowError(VisionPreprocessingError);
    }

    const physical = Buffer.alloc(9);
    physical.writeUInt32BE(2835, 0);
    physical.writeUInt32BE(2835, 4);
    physical[8] = 1;

    const timestamp = Buffer.alloc(7);
    timestamp.writeUInt16BE(2026, 0);
    timestamp[2] = 8;
    timestamp[3] = 31;
    timestamp[4] = 10;
    timestamp[5] = 10;
    timestamp[6] = 0;

    for (const chunk of [
      makePngChunk("tEXt", Buffer.from("note\u0000value")),
      makePngChunk("pHYs", physical),
      makePngChunk("tIME", timestamp)
    ]) {
      expect(snapshot(insertAfterIhdr(base, chunk)).metadata.width).toBe(2);
    }
  });

  it("rejects malformed transparency and gamma chunk structure with valid CRCs", () => {
    const rgba = makePng(1, 1);
    expect(() => snapshot(insertAfterIhdr(
      rgba,
      makePngChunk("tRNS", Buffer.alloc(1))
    ))).toThrowError(VisionPreprocessingError);

    expect(() => snapshot(insertAfterIhdr(
      rgba,
      makePngChunk("gAMA", Buffer.alloc(3))
    ))).toThrowError(VisionPreprocessingError);

    expect(() => snapshot(insertAfterIhdr(
      rgba,
      makePngChunk("gAMA", Buffer.alloc(4)),
      makePngChunk("gAMA", Buffer.alloc(4))
    ))).toThrowError(VisionPreprocessingError);
  });

  it("rejects transparency samples outside the declared bit depth and zero gamma", () => {
    const grayscaleTrns = makeMinimalPng(0, [0], {
      transparency: [0x01, 0x00]
    });
    expect(() => snapshot(grayscaleTrns)).toThrowError(VisionPreprocessingError);

    const rgbTrns = makeMinimalPng(2, [0, 0, 0], {
      transparency: [0, 0, 0, 0, 1, 0]
    });
    expect(() => snapshot(rgbTrns)).toThrowError(VisionPreprocessingError);

    expect(() => snapshot(insertAfterIhdr(
      makePng(1, 1),
      makePngChunk("gAMA", Buffer.alloc(4))
    ))).toThrowError(VisionPreprocessingError);
  });

  it("rejects nonconsecutive IDAT and unsupported critical chunks with valid CRCs", () => {
    const base = makePng(2, 2);
    const firstIdat = base.indexOf(Buffer.from("IDAT", "ascii")) - 4;
    if (firstIdat < 0) throw new Error("Generated PNG has no IDAT chunk");
    const idatLength = base.readUInt32BE(firstIdat);
    const idatEnd = firstIdat + 12 + idatLength;
    const split = Buffer.concat([
      base.subarray(0, idatEnd),
      makePngChunk("tEXt"),
      makePngChunk("IDAT"),
      base.subarray(idatEnd)
    ]);
    expect(() => snapshot(split)).toThrowError(VisionPreprocessingError);

    expect(() => snapshot(insertAfterIhdr(
      base,
      makePngChunk("ABCD")
    ))).toThrowError(VisionPreprocessingError);
  });

  it("rejects ancillary CRC corruption before decoder-specific handling", () => {
    const ancillary = makePngChunk("tEXt", Buffer.from("safe"));
    const crcOffset = ancillary.length - 1;
    const last = ancillary[crcOffset];
    if (last === undefined) throw new Error("Ancillary chunk unexpectedly empty");
    ancillary[crcOffset] = last ^ 0xff;
    expect(() => snapshot(insertAfterIhdr(makePng(1, 1), ancillary)))
      .toThrowError(VisionPreprocessingError);
  });

  it("rejects caller dimension mismatches", () => {
    const bytes = makePng(3, 2);
    expect(() => snapshot(bytes, { declaredWidth: 4 }))
      .toThrowError(VisionPreprocessingError);
    try {
      snapshot(bytes, { declaredWidth: 4 });
    } catch (error) {
      expectCode(error, "DIMENSION_MISMATCH");
    }
  });

  it("enforces encoded-byte, width, height, and pixel limits before accepting a snapshot", () => {
    const bytes = makePng(8, 6);
    const base = {
      snapshotId: "bounded",
      sourceType: "BROWSER_SCREENSHOT" as const,
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      encodedBytes: bytes
    };

    expect(() => createValidatedImageSnapshot(base, { maxEncodedBytes: bytes.length - 1 }))
      .toThrowError(VisionPreprocessingError);
    expect(() => createValidatedImageSnapshot(base, { maxWidth: 7 }))
      .toThrowError(VisionPreprocessingError);
    expect(() => createValidatedImageSnapshot(base, { maxHeight: 5 }))
      .toThrowError(VisionPreprocessingError);
    expect(() => createValidatedImageSnapshot(base, { maxPixels: 47 }))
      .toThrowError(VisionPreprocessingError);

    try {
      createValidatedImageSnapshot(base, { maxEncodedBytes: bytes.length - 1 });
    } catch (error) {
      expectCode(error, "IMAGE_TOO_LARGE_BYTES");
    }
  });

  it("rejects inherited snapshot input fields instead of trusting the prototype chain", () => {
    const inherited = Object.create({
      snapshotId: "inherited",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      encodedBytes: makePng(1, 1)
    });

    try {
      createValidatedImageSnapshot(
        inherited as unknown as Parameters<typeof createValidatedImageSnapshot>[0]
      );
      throw new Error("Expected inherited snapshot input rejection");
    } catch (error) {
      expectCode(error, "INVALID_IMAGE");
    }
  });

  it("fails closed on revoked validation-limit proxies", () => {
    const validInput = {
      snapshotId: "revoked-limits",
      sourceType: "WHITEBOARD_SNAPSHOT" as const,
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      encodedBytes: makePng(1, 1)
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => createValidatedImageSnapshot(
      validInput,
      revoked.proxy as unknown as Parameters<typeof createValidatedImageSnapshot>[1]
    )).toThrowError(RangeError);
  });

  it("fails closed on hostile snapshot input and validation-limit getters", () => {
    const hostileInput = new Proxy({}, {
      get() {
        throw new Error("hostile snapshot getter");
      }
    });
    try {
      createValidatedImageSnapshot(hostileInput as unknown as Parameters<typeof createValidatedImageSnapshot>[0]);
      throw new Error("Expected hostile snapshot rejection");
    } catch (error) {
      expectCode(error, "INVALID_IMAGE");
    }

    const validInput = {
      snapshotId: "hostile-limits",
      sourceType: "WHITEBOARD_SNAPSHOT" as const,
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      encodedBytes: makePng(1, 1)
    };
    const hostileLimits = new Proxy({}, {
      get() {
        throw new Error("hostile limits getter");
      }
    });
    expect(() => createValidatedImageSnapshot(
      validInput,
      hostileLimits as unknown as Parameters<typeof createValidatedImageSnapshot>[1]
    )).toThrowError(RangeError);
  });

  it("rejects unknown snapshot fields before invoking their getters", () => {
    let getterCalls = 0;
    const input: Record<string, unknown> = {
      snapshotId: "unknown-getter",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      encodedBytes: makePng(1, 1)
    };
    Object.defineProperty(input, "unexpected", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("unexpected getter must not run");
      }
    });

    expect(() => createValidatedImageSnapshot(
      input as Parameters<typeof createValidatedImageSnapshot>[0]
    )).toThrowError(VisionPreprocessingError);
    expect(getterCalls).toBe(0);
  });

  it("rejects null image limit overrides rather than silently using defaults", () => {
    expect(() => createValidatedImageSnapshot({
      snapshotId: "null-limits",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      encodedBytes: makePng(1, 1)
    }, null as unknown as Parameters<typeof createValidatedImageSnapshot>[1])).toThrowError(RangeError);
  });

  it("rejects unknown snapshot fields and misspelled validation limit keys", () => {
    const bytes = makePng(2, 2);
    expect(() => createValidatedImageSnapshot({
      snapshotId: "strict-input",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      encodedBytes: bytes,
      unexpectedField: true
    } as unknown as Parameters<typeof createValidatedImageSnapshot>[0])).toThrowError(VisionPreprocessingError);

    expect(() => createValidatedImageSnapshot({
      snapshotId: "strict-limit",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      encodedBytes: bytes
    }, {
      maxEncodedBytes: bytes.length,
      maxWidth: 10,
      maxHeight: 10,
      maxPixels: 100,
      maxPixles: 1
    } as unknown as Parameters<typeof createValidatedImageSnapshot>[1])).toThrowError(RangeError);
  });

  it("uses intrinsic typed-array length instead of spoofable subclass byteLength accessors", () => {
    class OverreportingView extends Uint8Array {
      public override get byteLength(): number {
        return 64 * 1024 * 1024 + 1;
      }
    }
    const overreported = new OverreportingView([7]);
    expect(sha256ImageBytes(overreported)).toBe(sha256ImageBytes(new Uint8Array([7])));

    class UnderreportingView extends Uint8Array {
      public override get byteLength(): number {
        return 1;
      }
    }
    const underreported = new UnderreportingView(100);
    expect(() => createValidatedImageSnapshot({
      snapshotId: "underreported-bytes",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png" as const,
      encodedBytes: underreported
    }, {
      maxEncodedBytes: 50
    })).toThrowError(VisionPreprocessingError);
    try {
      createValidatedImageSnapshot({
        snapshotId: "underreported-bytes",
        sourceType: "WHITEBOARD_SNAPSHOT",
        sourceRevision: BoardRevisionSchema.parse(1),
        capturedAtMs: 1,
        mimeType: "image/png" as const,
        encodedBytes: underreported
      }, {
        maxEncodedBytes: 50
      });
    } catch (error) {
      expectCode(error, "IMAGE_TOO_LARGE_BYTES");
    }
  });

  it("identifies exact image payloads and repeated processing identities", () => {
    const bytes = makePng(3, 3);
    const first = snapshot(bytes, { id: "a", revision: 9 });
    const second = snapshot(bytes, { id: "b", revision: 9 });
    const third = snapshot(bytes, { id: "c", revision: 10 });
    const different = snapshot(makePng(3, 3, () => [255, 0, 0, 255]), { id: "d", revision: 9 });

    const repeated = snapshot(bytes, { id: "a", revision: 9 });
    expect(exactImagePayloadDuplicate(first, second)).toBe(true);
    expect(sameRevisionAndImage(first, repeated)).toBe(true);
    expect(sameRevisionAndImage(first, second)).toBe(false);
    expect(sameRevisionAndImage(first, third)).toBe(false);
    expect(exactImagePayloadDuplicate(first, different)).toBe(false);
    expect(revisionImageProcessingKey(first)).toBe(revisionImageProcessingKey(repeated));
    expect(revisionImageProcessingKey(first)).not.toBe(revisionImageProcessingKey(second));
    expect(deduplicateExactImagePayloads([first, second, different])).toEqual([first, different]);
  });
});

  it("does not conflate identical crop bytes from distinct parent snapshots that reuse caller IDs", async () => {
    const common = (x: number, y: number): readonly [number, number, number, number] =>
      x < 2 && y < 2 ? [42, 42, 42, 255] : [0, 0, 0, 255];
    const changed = (x: number, y: number): readonly [number, number, number, number] =>
      x < 2 && y < 2 ? [42, 42, 42, 255] : [255, 255, 255, 255];

    const firstSource = snapshot(makePng(4, 4, common), { id: "reused-snapshot-id", revision: 18 });
    const secondSource = snapshot(makePng(4, 4, changed), { id: "reused-snapshot-id", revision: 18 });
    const firstCrop = (await cropImage(firstSource, { x: 0, y: 0, width: 2, height: 2 })).artifact;
    const secondCrop = (await cropImage(secondSource, { x: 0, y: 0, width: 2, height: 2 })).artifact;

    expect(exactImagePayloadDuplicate(firstCrop, secondCrop)).toBe(true);
    expect(firstCrop.metadata.sourceImageIdentity)
      .not.toBe(secondCrop.metadata.sourceImageIdentity);
    expect(firstCrop.metadata.artifactId).not.toBe(secondCrop.metadata.artifactId);
    expect(revisionImageProcessingKey(firstCrop))
      .not.toBe(revisionImageProcessingKey(secondCrop));
  });

  it("does not conflate identical crop bytes from different coordinates in processing deduplication", async () => {
    const source = snapshot(makePng(6, 2, () => [42, 42, 42, 255]), { id: "same-board", revision: 14 });
    const left = (await cropImage(source, { x: 0, y: 0, width: 2, height: 2 })).artifact;
    const right = (await cropImage(source, { x: 4, y: 0, width: 2, height: 2 })).artifact;

    expect(exactImagePayloadDuplicate(left, right)).toBe(true);
    expect(revisionImageProcessingKey(left)).not.toBe(revisionImageProcessingKey(right));
    expect(sameRevisionAndImage(left, right)).toBe(false);
  });

  it("does not trust a caller-supplied array iterator to enforce deduplication bounds", () => {
    const source = snapshot(makePng(1, 1));
    const images: ImageSnapshot[] = [source, source];
    Object.defineProperty(images, Symbol.iterator, {
      configurable: true,
      value: () => {
        throw new Error("caller iterator must not run");
      }
    });
    expect(deduplicateExactImagePayloads(images)).toEqual([source]);
  });

  it("fails closed on hostile deduplication entry access", () => {
    const images: ImageSnapshot[] = [];
    Object.defineProperty(images, "0", {
      enumerable: true,
      get() {
        throw new Error("hostile image entry");
      }
    });
    Object.defineProperty(images, "length", { value: 1 });
    expect(() => deduplicateExactImagePayloads(images)).toThrowError(TypeError);
  });

  it("bounds public exact-dedup candidate collections", () => {
    const source = snapshot(makePng(1, 1));
    expect(() => deduplicateExactImagePayloads(Array.from({ length: 2049 }, () => source)))
      .toThrowError(RangeError);
  });

describe("vision geometry", () => {
  it("normalizes, clips, expands, intersects, unions, and measures raster rectangles", () => {
    expect(normalizeRect({ x1: 8, y1: 9, x2: 2, y2: 3 })).toEqual({ x: 2, y: 3, width: 6, height: 6 });
    expect(clipRectToBounds(
      { x: -4, y: 2, width: 10, height: 8 },
      { x: 0, y: 0, width: 10, height: 10 }
    )).toEqual({ x: 0, y: 2, width: 6, height: 8 });
    expect(expandRect(
      { x: 2, y: 2, width: 3, height: 3 },
      4,
      { x: 0, y: 0, width: 10, height: 10 }
    )).toEqual({ x: 0, y: 0, width: 9, height: 9 });
    expect(intersectRects(
      { x: 0, y: 0, width: 5, height: 5 },
      { x: 4, y: 3, width: 5, height: 5 }
    )).toEqual({ x: 4, y: 3, width: 1, height: 2 });
    expect(unionRects([
      { x: 2, y: 4, width: 2, height: 2 },
      { x: 0, y: 1, width: 3, height: 8 }
    ])).toEqual({ x: 0, y: 1, width: 4, height: 8 });
    expect(rectArea({ x: 0, y: 0, width: 4, height: 7 })).toBe(28);
  });

  it("treats edge-touching rectangles as non-overlapping and containment as inclusive", () => {
    const outer = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectContains(outer, { x: 0, y: 0, width: 10, height: 10 })).toBe(true);
    expect(rectContains(outer, { x: 9, y: 9, width: 1, height: 1 })).toBe(true);
    expect(rectContains(outer, { x: 10, y: 9, width: 1, height: 1 })).toBe(false);
    expect(rectsOverlap(
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 2, y: 0, width: 2, height: 2 }
    )).toBe(false);
    expect(rectsOverlap(
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 1, y: 1, width: 2, height: 2 }
    )).toBe(true);
  });

  it("rejects zero/negative dimensions and explicit out-of-bounds crops", () => {
    expect(() => validateImageRect({ x: 0, y: 0, width: 0, height: 2 })).toThrowError(VisionPreprocessingError);
    expect(() => validateImageRect({ x: 0, y: 0, width: -1, height: 2 })).toThrowError(VisionPreprocessingError);
    expect(() => normalizeRect({ x1: 1, y1: 2, x2: 1, y2: 8 })).toThrowError(VisionPreprocessingError);
    expect(() => assertRectWithinImage(
      { x: 8, y: 0, width: 3, height: 2 },
      { width: 10, height: 10 }
    )).toThrowError(VisionPreprocessingError);
    expect(imageBounds({ width: 10, height: 5 })).toEqual({ x: 0, y: 0, width: 10, height: 5 });
  });

  it("rejects inherited numeric geometry entries instead of trusting the prototype chain", () => {
    const inherited = new Array<{ x: number; y: number; width: number; height: number }>(1);
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, "0", {
      value: { x: 0, y: 0, width: 1, height: 1 },
      enumerable: true
    });
    Object.setPrototypeOf(inherited, prototype);
    expect(() => unionRects(inherited)).toThrowError(VisionPreprocessingError);
  });

  it("rejects inherited geometry fields instead of trusting the prototype chain", () => {
    const inheritedDimensions = Object.create({ width: 1, height: 1 });
    expect(() => imageBounds(
      inheritedDimensions as unknown as Parameters<typeof imageBounds>[0]
    )).toThrowError(VisionPreprocessingError);
  });

  it("fails closed on hostile rectangle, corner, and dimension objects", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile geometry getter");
      }
    });

    expect(() => validateImageRect(
      hostile as unknown as Parameters<typeof validateImageRect>[0]
    )).toThrowError(VisionPreprocessingError);
    expect(() => normalizeRect(
      hostile as unknown as Parameters<typeof normalizeRect>[0]
    )).toThrowError(VisionPreprocessingError);
    expect(() => imageBounds(
      hostile as unknown as Parameters<typeof imageBounds>[0]
    )).toThrowError(VisionPreprocessingError);
  });

  it("fails closed on revoked or hostile geometry collections", () => {
    const revoked = Proxy.revocable([] as Array<{ x: number; y: number; width: number; height: number }>, {});
    revoked.revoke();
    expect(() => unionRects(revoked.proxy)).toThrowError(TypeError);

    const hostile: Array<{ x: number; y: number; width: number; height: number }> = [];
    Object.defineProperty(hostile, "0", {
      enumerable: true,
      get() {
        throw new Error("hostile geometry entry");
      }
    });
    Object.defineProperty(hostile, "length", { value: 1 });
    expect(() => unionRects(hostile)).toThrowError(TypeError);
  });

  it("bounds public rectangle collection operations", () => {
    const tooMany = Array.from({ length: 2049 }, () => ({ x: 0, y: 0, width: 1, height: 1 }));
    expect(() => unionRects(tooMany)).toThrowError(RangeError);
  });

  it("rejects rectangles whose derived right or bottom edge leaves the safe integer range", () => {
    expect(() => validateImageRect({
      x: Number.MAX_SAFE_INTEGER,
      y: 0,
      width: 1,
      height: 1
    })).toThrowError(VisionPreprocessingError);
    expect(() => validateImageRect({
      x: 0,
      y: Number.MAX_SAFE_INTEGER,
      width: 1,
      height: 1
    })).toThrowError(VisionPreprocessingError);
  });
});

describe("dirty-region planning", () => {
  it("pads, clips, and transitively coalesces overlapping dirty regions deterministically", () => {
    const regions = [
      { x: 10, y: 10, width: 10, height: 10 },
      { x: 18, y: 10, width: 10, height: 10 },
      { x: 27, y: 10, width: 5, height: 10 }
    ] as const;
    expect(coalesceOverlappingRegions(regions)).toEqual([
      { x: 10, y: 10, width: 22, height: 10 }
    ]);

    const plan = planDirtyRegions(regions, { width: 100, height: 100 }, {
      paddingPixels: 1,
      maxRegionCount: 8,
      maxTotalAnalyzedArea: 10_000,
      fullFrameFallbackAreaRatio: 1
    });
    expect(plan.mode).toBe("REGIONS");
    if (plan.mode === "REGIONS") {
      expect(plan.regions).toEqual([{ x: 9, y: 9, width: 24, height: 12 }]);
    }
  });

  it("directly rasterizes fractional and zero-size dirty hints outward deterministically", () => {
    expect(rasterizeDirtyRegion({ x: 1.25, y: 2.75, width: 0, height: 0 }))
      .toEqual({ x: 1, y: 2, width: 1, height: 1 });
    expect(rasterizeDirtyRegion({ x: -1.25, y: -2.75, width: 2.5, height: 3.5 }))
      .toEqual({ x: -2, y: -3, width: 4, height: 4 });
  });

  it("rasterizes fractional and zero-size dirty hints without weakening crop rectangles", () => {
    const plan = planDirtyRegions([
      { x: 1.25, y: 2.75, width: 0, height: 0 },
      { x: 5.2, y: 5.2, width: 1.1, height: 1.1 }
    ], { width: 20, height: 20 }, {
      paddingPixels: 0,
      maxRegionCount: 4,
      maxTotalAnalyzedArea: 400,
      fullFrameFallbackAreaRatio: 1
    });
    expect(plan.mode).toBe("REGIONS");
    if (plan.mode === "REGIONS") {
      expect(plan.regions).toEqual([
        { x: 1, y: 2, width: 1, height: 1 },
        { x: 5, y: 5, width: 2, height: 2 }
      ]);
    }
    expect(() => validateImageRect({ x: 1, y: 2, width: 0, height: 1 }))
      .toThrowError(VisionPreprocessingError);
  });

  it("falls back to full frame when fragmentation exceeds the region count", () => {
    const plan = planDirtyRegions([
      { x: 0, y: 0, width: 5, height: 5 },
      { x: 90, y: 90, width: 5, height: 5 }
    ], { width: 100, height: 100 }, {
      paddingPixels: 0,
      maxRegionCount: 1,
      maxTotalAnalyzedArea: 10_000,
      fullFrameFallbackAreaRatio: 1
    });
    expect(plan).toMatchObject({
      mode: "FULL_FRAME",
      fallbackReason: "TOO_MANY_REGIONS",
      analyzedArea: 10_000,
      regions: [{ x: 0, y: 0, width: 100, height: 100 }]
    });
  });

  it("fails directly when coalesced dirty regions exceed the configured area budget", () => {
    try {
      planDirtyRegions([
        { x: 0, y: 0, width: 80, height: 80 }
      ], { width: 100, height: 100 }, {
        paddingPixels: 0,
        maxInputRegions: 4,
        maxRegionCount: 4,
        maxTotalAnalyzedArea: 5000,
        fullFrameFallbackAreaRatio: 1
      });
      throw new Error("Expected dirty area budget rejection");
    } catch (error) {
      expectCode(error, "DIRTY_PLAN_EXCEEDS_BUDGET");
    }
  });

  it("fails when coverage ratio requires full-frame fallback but the full frame exceeds area budget", () => {
    expect(() => planDirtyRegions([
      { x: 0, y: 0, width: 50, height: 10 }
    ], { width: 100, height: 100 }, {
      paddingPixels: 0,
      maxInputRegions: 8,
      maxRegionCount: 8,
      maxTotalAnalyzedArea: 1000,
      fullFrameFallbackAreaRatio: 0.05
    })).toThrowError(VisionPreprocessingError);
  });

  it("falls back for excessive analyzed area and fails if that full frame would violate the area budget", () => {
    const full = planDirtyRegions([
      { x: 0, y: 0, width: 80, height: 80 }
    ], { width: 100, height: 100 }, {
      paddingPixels: 0,
      maxRegionCount: 4,
      maxTotalAnalyzedArea: 10_000,
      fullFrameFallbackAreaRatio: 0.5
    });
    expect(full.mode).toBe("FULL_FRAME");

    expect(() => planDirtyRegions([
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 60, y: 60, width: 40, height: 40 }
    ], { width: 100, height: 100 }, {
      paddingPixels: 0,
      maxRegionCount: 1,
      maxTotalAnalyzedArea: 5000,
      fullFrameFallbackAreaRatio: 1
    })).toThrowError(VisionPreprocessingError);
  });

  it("ignores dirty rectangles wholly outside the frame and preserves deterministic repeatability", () => {
    const input = [
      { x: 5, y: 5, width: 5, height: 5 },
      { x: 1000, y: 1000, width: 2, height: 2 }
    ] as const;
    const config = { paddingPixels: 0, maxRegionCount: 4, maxTotalAnalyzedArea: 1000, fullFrameFallbackAreaRatio: 1 };
    expect(planDirtyRegions(input, { width: 20, height: 20 }, config))
      .toEqual(planDirtyRegions(input, { width: 20, height: 20 }, config));
  });

  it("does not let out-of-frame dirty hints force configured full-frame fallback", () => {
    const plan = planDirtyRegions([
      { x: 100, y: 100, width: 1, height: 1 },
      { x: 200, y: 200, width: 1, height: 1 }
    ], { width: 20, height: 20 }, {
      maxInputRegions: 1,
      maxRegionCount: 1
    });
    expect(plan).toEqual({ mode: "NONE", regions: [], analyzedArea: 0 });
  });

  it("fails closed on hostile dirty-frame dimensions", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile dirty dimensions");
      }
    });
    try {
      planDirtyRegions(
        [{ x: 0, y: 0, width: 1, height: 1 }],
        hostile as unknown as Parameters<typeof planDirtyRegions>[1]
      );
      throw new Error("Expected hostile dirty dimensions rejection");
    } catch (error) {
      expectCode(error, "INVALID_RECTANGLE");
    }
  });

  it("ignores inherited dirty planner overrides and uses only own configuration fields", () => {
    const inheritedConfig = Object.create({ paddingPixels: 0 });
    const plan = planDirtyRegions(
      [{ x: 50, y: 50, width: 1, height: 1 }],
      { width: 100, height: 100 },
      inheritedConfig as Parameters<typeof planDirtyRegions>[2]
    );
    expect(plan.mode).toBe("REGIONS");
    if (plan.mode !== "REGIONS") throw new Error("Expected regional dirty plan");
    expect(plan.regions).toEqual([{ x: 26, y: 26, width: 49, height: 49 }]);
  });

  it("fails closed on hostile dirty-region objects and revoked planner config", () => {
    const hostileRegion = new Proxy({}, {
      get() {
        throw new Error("hostile dirty getter");
      }
    });
    try {
      rasterizeDirtyRegion(hostileRegion as unknown as Parameters<typeof rasterizeDirtyRegion>[0]);
      throw new Error("Expected hostile dirty-region rejection");
    } catch (error) {
      expectCode(error, "INVALID_RECTANGLE");
    }

    const revokedConfig = Proxy.revocable({}, {});
    revokedConfig.revoke();
    expect(() => planDirtyRegions(
      [{ x: 0, y: 0, width: 1, height: 1 }],
      { width: 10, height: 10 },
      revokedConfig.proxy as unknown as Parameters<typeof planDirtyRegions>[2]
    )).toThrowError(RangeError);
  });

  it("rejects null planner configuration rather than silently using defaults", () => {
    expect(() => planDirtyRegions(
      [{ x: 0, y: 0, width: 1, height: 1 }],
      { width: 10, height: 10 },
      null as unknown as Parameters<typeof planDirtyRegions>[2]
    )).toThrowError(RangeError);
  });

  it("validates dirty rectangles before configured over-count fallback", () => {
    expect(() => planDirtyRegions([
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 5, y: 5, width: -1, height: 2 }
    ], { width: 20, height: 20 }, {
      maxInputRegions: 1,
      maxRegionCount: 1
    })).toThrowError(VisionPreprocessingError);
  });

  it("returns NONE for purely out-of-frame hints even when standalone frame area is numerically huge", () => {
    expect(planDirtyRegions(
      [{ x: -10, y: -10, width: 1, height: 1 }],
      { width: Number.MAX_SAFE_INTEGER, height: 2 }
    )).toEqual({
      mode: "NONE",
      regions: [],
      analyzedArea: 0
    });
  });

  it("rejects nonempty planning on a frame whose area exceeds safe numeric range", () => {
    expect(() => planDirtyRegions(
      [{ x: 0, y: 0, width: 1, height: 1 }],
      { width: Number.MAX_SAFE_INTEGER, height: 2 }
    )).toThrowError(VisionPreprocessingError);
    try {
      planDirtyRegions(
        [{ x: 0, y: 0, width: 1, height: 1 }],
        { width: Number.MAX_SAFE_INTEGER, height: 2 }
      );
    } catch (error) {
      expectCode(error, "DIRTY_PLAN_EXCEEDS_BUDGET");
    }
  });

  it("rejects dirty-region lists above the package hard count instead of triggering work", () => {
    const tooMany = Array.from({ length: 2049 }, () => ({ x: 0, y: 0, width: 1, height: 1 }));
    expect(() => planDirtyRegions(tooMany, { width: 20, height: 20 }))
      .toThrowError(VisionPreprocessingError);
  });
});

describe("crop, resize, tiling, and cancellation", () => {
  it("crops exact pixels without silently clipping and preserves source revision/coordinates", async () => {
    const source = snapshot(makePng(4, 4, (x, y) => [x * 10, y * 20, 7, 255]), { revision: 11 });
    const result = await cropImage(source, { x: 1, y: 1, width: 2, height: 2 });
    expect(result.artifact.metadata).toMatchObject({
      kind: "CROP",
      sourceSnapshotId: "snapshot-1",
      sourceRevision: 11,
      width: 2,
      height: 2,
      sourceBounds: { x: 1, y: 1, width: 2, height: 2 },
      coordinateTransform: { offsetX: 1, offsetY: 1, scaleX: 1, scaleY: 1 }
    });
    expect(rgbaAt(result.artifact.readBytes(), 0, 0)).toEqual([10, 20, 7, 255]);
    expect(rgbaAt(result.artifact.readBytes(), 1, 1)).toEqual([20, 40, 7, 255]);
    expect(cropPayloadKey(result.artifact)).toBe(result.artifact.metadata.contentDigest);

    await expect(cropImage(source, { x: 3, y: 3, width: 2, height: 2 })).rejects.toMatchObject({ code: "OUT_OF_BOUNDS" });
  });

  it("preserves accepted PNG gamma metadata through crop, resize, and tile re-encoding", async () => {
    const withGamma = insertAfterIhdr(
      makePng(4, 4),
      makePngChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f]))
    );
    const source = snapshot(withGamma);

    const crop = await cropImage(source, { x: 0, y: 0, width: 2, height: 2 });
    const resized = await downscaleImage(source, {
      maxWidth: 2,
      maxHeight: 2,
      maxPixels: 4
    });
    const tiled = await tileImage(source, {
      tileWidth: 2,
      tileHeight: 2,
      overlap: 0,
      maxTileCount: 4
    });

    const outputs = [
      crop.artifact.readBytes(),
      resized.image.readBytes(),
      tiled.tiles[0]?.artifact.readBytes()
    ];
    for (const bytes of outputs) {
      if (bytes === undefined) throw new Error("Expected processed PNG output");
      expect(PNG.sync.read(Buffer.from(bytes)).gamma).toBeCloseTo(0.45455, 5);
    }
  });

  it("produces byte-identical deterministic crops and safe diagnostics", async () => {
    const source = snapshot(makePng(8, 8));
    const times = [10, 15];
    const first = await cropImage(source, { x: 2, y: 2, width: 4, height: 4 }, {
      now: () => times.shift() ?? 15
    });
    const second = await cropImage(source, { x: 2, y: 2, width: 4, height: 4 });
    expect(first.artifact.metadata.artifactId).toBe(second.artifact.metadata.artifactId);
    expect(first.artifact.metadata.contentDigest).toBe(second.artifact.metadata.contentDigest);
    expect(exactImagePayloadDuplicate(first.artifact, second.artifact)).toBe(true);
    expect(first.diagnostics).toMatchObject({
      operation: "CROP",
      sourceDimensions: { width: 8, height: 8 },
      outputDimensions: { width: 4, height: 4 },
      cropCount: 1,
      tileCount: 0,
      durationMs: 5,
      outcome: "SUCCESS"
    });
    expect(JSON.stringify(first.diagnostics)).not.toContain("encodedBytes");
  });

  it("ignores inherited processing options instead of trusting the prototype chain", async () => {
    const source = snapshot(makePng(2, 2));
    const inheritedOptions = Object.create({ maxOutputEncodedBytes: 0 });
    const result = await cropImage(
      source,
      { x: 0, y: 0, width: 1, height: 1 },
      inheritedOptions as Parameters<typeof cropImage>[2]
    );
    expect(result.artifact.metadata.width).toBe(1);
  });

  it("fails closed on revoked processing option proxies", async () => {
    const source = snapshot(makePng(2, 2));
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    await expect(cropImage(
      source,
      { x: 0, y: 0, width: 1, height: 1 },
      revoked.proxy as unknown as Parameters<typeof cropImage>[2]
    )).rejects.toThrowError(TypeError);
  });

  it("fails closed on hostile processing option enumeration and getters", async () => {
    const source = snapshot(makePng(2, 2));
    const hostileEnumeration = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile ownKeys trap");
      }
    });
    await expect(cropImage(
      source,
      { x: 0, y: 0, width: 1, height: 1 },
      hostileEnumeration as unknown as Parameters<typeof cropImage>[2]
    )).rejects.toThrowError(TypeError);

    const hostileGetter = Object.defineProperty({}, "maxOutputEncodedBytes", {
      enumerable: true,
      get() {
        throw new Error("hostile option getter");
      }
    });
    await expect(cropImage(
      source,
      { x: 0, y: 0, width: 1, height: 1 },
      hostileGetter as unknown as Parameters<typeof cropImage>[2]
    )).rejects.toThrowError(TypeError);
  });

  it("snapshots processing option getters once to prevent validation/use races", async () => {
    const source = snapshot(makePng(4, 4));
    let reads = 0;
    const options = Object.defineProperty({}, "maxOutputEncodedBytes", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 1_000_000 : 0;
      }
    }) as Parameters<typeof cropImage>[2];

    const result = await cropImage(source, { x: 0, y: 0, width: 2, height: 2 }, options);
    expect(result.artifact.metadata.width).toBe(2);
    expect(reads).toBe(1);
  });

  it("fails closed on revoked AbortSignal proxies", async () => {
    const source = snapshot(makePng(2, 2));
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    await expect(cropImage(
      source,
      { x: 0, y: 0, width: 1, height: 1 },
      { signal: revoked.proxy as unknown as AbortSignal }
    )).rejects.toThrowError(TypeError);
  });

  it("rejects unknown or malformed processing options before image work", async () => {
    const source = snapshot(makePng(4, 4));
    await expect(cropImage(
      source,
      { x: 0, y: 0, width: 2, height: 2 },
      { maxOutputEncodedByte: 1 } as unknown as Parameters<typeof cropImage>[2]
    )).rejects.toThrowError(RangeError);
    await expect(downscaleImage(
      source,
      { maxWidth: 2, maxHeight: 2, maxPixels: 4 },
      { signal: {} } as unknown as Parameters<typeof downscaleImage>[2]
    )).rejects.toThrowError(TypeError);
  });

  it("plans and executes aspect-ratio-preserving downscaling and never upscales", async () => {
    expect(planDownscale({ width: 100, height: 50 }, { maxWidth: 40, maxHeight: 40, maxPixels: 1600 }))
      .toMatchObject({ resized: true, resultWidth: 40, resultHeight: 20 });

    const source = snapshot(makePng(100, 50));
    const resized = await downscaleImage(source, { maxWidth: 40, maxHeight: 40, maxPixels: 1600 });
    expect(resized.image).not.toBe(source);
    expect(resized.image.metadata).toMatchObject({
      width: 40,
      height: 20,
      sourceRevision: 3,
      sourceBounds: { x: 0, y: 0, width: 100, height: 50 },
      coordinateTransform: { offsetX: 0, offsetY: 0, scaleX: 2.5, scaleY: 2.5 }
    });

    const unchanged = await downscaleImage(source, { maxWidth: 200, maxHeight: 200, maxPixels: 100_000 });
    expect(unchanged.plan.resized).toBe(false);
    expect(unchanged.image).toBe(source);
  });

  it("produces byte-identical deterministic resize outputs for identical inputs", async () => {
    const source = snapshot(makePng(9, 7));
    const envelope = { maxWidth: 4, maxHeight: 4, maxPixels: 16 };
    const first = await downscaleImage(source, envelope);
    const second = await downscaleImage(source, envelope);

    expect(first.plan).toEqual(second.plan);
    expect(first.image.metadata.contentDigest).toBe(second.image.metadata.contentDigest);
    expect(first.image.readBytes().equals(second.image.readBytes())).toBe(true);
  });

  it("uses premultiplied-alpha interpolation so transparent edges do not acquire dark halos", async () => {
    const source = snapshot(makePng(2, 1, (x) => x === 0
      ? [255, 255, 255, 255]
      : [0, 0, 0, 0]));
    const resized = await downscaleImage(source, { maxWidth: 1, maxHeight: 1, maxPixels: 1 });
    expect(rgbaAt(resized.image.readBytes(), 0, 0)).toEqual([255, 255, 255, 128]);
  });

  it("fails closed on hostile downscale dimension and envelope objects", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile downscale getter");
      }
    });

    expect(() => planDownscale(
      hostile as unknown as Parameters<typeof planDownscale>[0],
      { maxWidth: 1, maxHeight: 1, maxPixels: 1 }
    )).toThrowError(RangeError);
    expect(() => planDownscale(
      { width: 2, height: 2 },
      hostile as unknown as Parameters<typeof planDownscale>[1]
    )).toThrowError(RangeError);
  });

  it("uses the nearest valid raster dimensions instead of avoidably distorting aspect ratio", () => {
    expect(planDownscale(
      { width: 9139, height: 9130 },
      { maxWidth: 3, maxHeight: 17, maxPixels: 100 }
    )).toMatchObject({
      resized: true,
      resultWidth: 3,
      resultHeight: 3
    });

    const pixelBounded = planDownscale(
      { width: 101, height: 101 },
      { maxWidth: 100, maxHeight: 100, maxPixels: 9_999 }
    );
    expect(pixelBounded.resultWidth).toBeLessThanOrEqual(100);
    expect(pixelBounded.resultHeight).toBeLessThanOrEqual(100);
    expect(pixelBounded.resultWidth * pixelBounded.resultHeight).toBeLessThanOrEqual(9_999);
  });

  it("bounds extreme standalone downscale planning without a linear correction loop", () => {
    const plan = planDownscale(
      { width: Number.MAX_SAFE_INTEGER, height: 1 },
      { maxWidth: Number.MAX_SAFE_INTEGER, maxHeight: 1, maxPixels: 1 }
    );
    expect(plan).toMatchObject({
      resized: true,
      resultWidth: 1,
      resultHeight: 1
    });
  });

  it("does not return an unchanged image that violates the configured output-byte ceiling", async () => {
    const source = snapshot(makePng(16, 16));
    await expect(downscaleImage(
      source,
      { maxWidth: 32, maxHeight: 32, maxPixels: 1024 },
      { maxOutputEncodedBytes: source.metadata.byteSize - 1 }
    )).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE_BYTES" });
  });

  it("fails closed on hostile tile dimension and configuration objects", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile tile getter");
      }
    });

    expect(() => planImageTiles(
      hostile as unknown as Parameters<typeof planImageTiles>[0],
      { tileWidth: 1, tileHeight: 1, overlap: 0, maxTileCount: 1 }
    )).toThrowError(RangeError);
    expect(() => planImageTiles(
      { width: 2, height: 2 },
      hostile as unknown as Parameters<typeof planImageTiles>[1]
    )).toThrowError(RangeError);
  });

  it("rejects overlap that is not smaller than each tile dimension even for a one-tile source", () => {
    expect(() => planImageTiles(
      { width: 2, height: 2 },
      { tileWidth: 4, tileHeight: 4, overlap: 4, maxTileCount: 1 }
    )).toThrowError(RangeError);

    expect(() => planImageTiles(
      { width: 2, height: 2 },
      { tileWidth: 4, tileHeight: 3, overlap: 3, maxTileCount: 1 }
    )).toThrowError(RangeError);
  });

  it("allows maxTileCount zero as an explicit prohibition and fails before tile allocation", () => {
    expect(() => planImageTiles(
      { width: 4, height: 4 },
      { tileWidth: 4, tileHeight: 4, overlap: 0, maxTileCount: 0 }
    )).toThrowError(VisionPreprocessingError);
  });

  it("keeps configured overlap exact at a partial final tile instead of shifting it backward", () => {
    const plan = planImageTiles({ width: 11, height: 4 }, {
      tileWidth: 4,
      tileHeight: 4,
      overlap: 1,
      maxTileCount: 4
    });
    expect(plan.map((item) => item.bounds)).toEqual([
      { x: 0, y: 0, width: 4, height: 4 },
      { x: 3, y: 0, width: 4, height: 4 },
      { x: 6, y: 0, width: 4, height: 4 },
      { x: 9, y: 0, width: 2, height: 4 }
    ]);
  });

  it("does not ignore a stricter total-output byte ceiling on single-output operations", async () => {
    const source = snapshot(makePng(4, 4));
    await expect(cropImage(
      source,
      { x: 0, y: 0, width: 1, height: 1 },
      { maxOutputEncodedBytes: 1_000_000, maxTotalOutputEncodedBytes: 0 }
    )).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE_BYTES" });

    await expect(downscaleImage(
      source,
      { maxWidth: 2, maxHeight: 2, maxPixels: 4 },
      { maxOutputEncodedBytes: 1_000_000, maxTotalOutputEncodedBytes: 0 }
    )).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE_BYTES" });
  });

  it("accepts zero output-byte ceilings as an explicit way to prohibit image output", async () => {
    const source = snapshot(makePng(4, 4));
    await expect(cropImage(
      source,
      { x: 0, y: 0, width: 1, height: 1 },
      { maxOutputEncodedBytes: 0 }
    )).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE_BYTES" });
  });

  it("rejects nonzero output ceilings that cannot structurally contain a PNG", async () => {
    const source = snapshot(makePng(4, 4));
    await expect(cropImage(
      source,
      { x: 0, y: 0, width: 1, height: 1 },
      { maxOutputEncodedBytes: 57 }
    )).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE_BYTES" });

    await expect(downscaleImage(
      source,
      { maxWidth: 2, maxHeight: 2, maxPixels: 4 },
      { maxOutputEncodedBytes: 57 }
    )).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE_BYTES" });

    await expect(tileImage(
      source,
      { tileWidth: 2, tileHeight: 2, overlap: 0, maxTileCount: 4 },
      { maxOutputEncodedBytes: 57 }
    )).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE_BYTES" });
  });

  it("rejects a combined tile byte budget that cannot structurally fit the planned PNG count", async () => {
    const source = snapshot(makePng(8, 4));
    await expect(tileImage(source, {
      tileWidth: 4,
      tileHeight: 4,
      overlap: 0,
      maxTileCount: 2
    }, {
      maxOutputEncodedBytes: 1_000_000,
      maxTotalOutputEncodedBytes: 115
    })).rejects.toMatchObject({ code: "OUTPUT_TOO_LARGE_BYTES" });
  });

  it("plans deterministic overlapping tiles with exact original-coordinate mappings", async () => {
    const source = snapshot(makePng(10, 6), { revision: 12 });
    const plan = planImageTiles({ width: 10, height: 6 }, {
      tileWidth: 4,
      tileHeight: 4,
      overlap: 1,
      maxTileCount: 6
    });
    expect(plan.map((item) => item.bounds)).toEqual([
      { x: 0, y: 0, width: 4, height: 4 },
      { x: 3, y: 0, width: 4, height: 4 },
      { x: 6, y: 0, width: 4, height: 4 },
      { x: 0, y: 2, width: 4, height: 4 },
      { x: 3, y: 2, width: 4, height: 4 },
      { x: 6, y: 2, width: 4, height: 4 }
    ]);

    const result = await tileImage(source, {
      tileWidth: 4,
      tileHeight: 4,
      overlap: 1,
      maxTileCount: 6
    });
    expect(result.tiles).toHaveLength(6);
    expect(result.tiles[4]?.artifact.metadata.sourceBounds).toEqual({
      x: 3,
      y: 2,
      width: 4,
      height: 4
    });
    expect(result.tiles[4]?.artifact.metadata.coordinateTransform).toEqual({
      offsetX: 3,
      offsetY: 2,
      scaleX: 1,
      scaleY: 1
    });
    expect(result.tiles.every((tile) => tile.artifact.metadata.sourceRevision === 12)).toBe(true);
    expect(result.diagnostics.tileCount).toBe(6);

    expect(() => planImageTiles({ width: 10, height: 6 }, {
      tileWidth: 4,
      tileHeight: 4,
      overlap: 1,
      maxTileCount: 5
    })).toThrowError(VisionPreprocessingError);
  });

  it("produces byte-identical deterministic tile outputs for identical inputs", async () => {
    const source = snapshot(makePng(9, 6));
    const config = { tileWidth: 4, tileHeight: 3, overlap: 1, maxTileCount: 8 };
    const first = await tileImage(source, config);
    const second = await tileImage(source, config);

    expect(first.tiles.map((tile) => tile.bounds))
      .toEqual(second.tiles.map((tile) => tile.bounds));
    expect(first.tiles.map((tile) => tile.artifact.metadata.artifactId))
      .toEqual(second.tiles.map((tile) => tile.artifact.metadata.artifactId));
    expect(first.tiles.every((tile, index) => {
      const other = second.tiles[index];
      return other !== undefined && tile.artifact.readBytes().equals(other.artifact.readBytes());
    })).toBe(true);
  });

  it("rejects enormous standalone tile plans before materializing axis arrays", () => {
    expect(() => planImageTiles(
      { width: Number.MAX_SAFE_INTEGER, height: 1 },
      { tileWidth: 1, tileHeight: 1, overlap: 0, maxTileCount: 1 }
    )).toThrowError(VisionPreprocessingError);
  });

  it("reports unsafe standalone tile area arithmetic as a tile-limit failure", () => {
    try {
      planImageTiles(
        { width: Number.MAX_SAFE_INTEGER, height: 2 },
        {
          tileWidth: Number.MAX_SAFE_INTEGER,
          tileHeight: 2,
          overlap: 0,
          maxTileCount: 1
        }
      );
      throw new Error("Expected unsafe tile area rejection");
    } catch (error) {
      expectCode(error, "TILE_LIMIT_EXCEEDED");
    }
  });

  it("rejects high-overlap tile plans whose duplicated raw pixel work exceeds the hard ceiling", () => {
    expect(() => planImageTiles(
      { width: 8192, height: 8192 },
      { tileWidth: 4096, tileHeight: 8192, overlap: 4000, maxTileCount: 50 }
    )).toThrowError(VisionPreprocessingError);
  });

  it("keeps immediate source bounds distinct from original coordinates across resize then crop", async () => {
    const source = snapshot(makePng(8, 4));
    const resized = await downscaleImage(source, {
      maxWidth: 4,
      maxHeight: 2,
      maxPixels: 8
    });
    if (!(resized.image instanceof VisionImageArtifact)) {
      throw new Error("Expected a resized artifact");
    }

    const crop = await cropImage(resized.image, { x: 1, y: 0, width: 2, height: 2 });
    expect(crop.artifact.metadata.sourceBounds).toEqual({
      x: 1,
      y: 0,
      width: 2,
      height: 2
    });
    expect(crop.artifact.metadata.coordinateTransform).toEqual({
      offsetX: 2,
      offsetY: 0,
      scaleX: 2,
      scaleY: 2
    });
    expect(crop.artifact.metadata.sourceSnapshotId).toBe(source.metadata.snapshotId);
    expect(crop.artifact.metadata.sourceRevision).toBe(source.metadata.sourceRevision);
    expect(crop.artifact.metadata.parentArtifactId).toBe(resized.image.metadata.artifactId);
    expect(crop.artifact.metadata.sourceImageIdentity)
      .toBe(prepareVisionImageRequest(resized.image, "provenance").imageIdentity);
  });

  it("composes crop and tile coordinate transforms back to the original snapshot", async () => {
    const source = snapshot(makePng(12, 8));
    const crop = await cropImage(source, { x: 2, y: 1, width: 8, height: 6 });
    const tiles = await tileImage(crop.artifact, {
      tileWidth: 4,
      tileHeight: 3,
      overlap: 0,
      maxTileCount: 4
    });
    expect(tiles.tiles[1]?.artifact.metadata.coordinateTransform).toEqual({
      offsetX: 6,
      offsetY: 1,
      scaleX: 1,
      scaleY: 1
    });
  });

  it("rejects a caller clock that moves backward instead of emitting fake zero duration", async () => {
    const source = snapshot(makePng(2, 2));
    const times = [10, 5];
    await expect(cropImage(source, { x: 0, y: 0, width: 1, height: 1 }, {
      now: () => times.shift() ?? 5
    })).rejects.toThrowError(RangeError);
  });

  it("fails closed on throwing, nonnumeric, or proxied processing clocks", async () => {
    const source = snapshot(makePng(2, 2));

    await expect(cropImage(source, { x: 0, y: 0, width: 1, height: 1 }, {
      now: () => {
        throw new Error("hostile clock");
      }
    })).rejects.toThrowError(TypeError);

    await expect(cropImage(source, { x: 0, y: 0, width: 1, height: 1 }, {
      now: (() => "not-a-number") as unknown as () => number
    })).rejects.toThrowError(RangeError);

    const proxiedClock = new Proxy(() => 1, {});
    await expect(cropImage(source, { x: 0, y: 0, width: 1, height: 1 }, {
      now: proxiedClock
    })).rejects.toThrowError(TypeError);
  });

  it("rejects unsafe processing clock values before pixel work begins", async () => {
    const source = snapshot(makePng(4, 4));
    await expect(cropImage(source, { x: 0, y: 0, width: 1, height: 1 }, {
      now: () => -1
    })).rejects.toThrowError(RangeError);
    await expect(cropImage(source, { x: 0, y: 0, width: 1, height: 1 }, {
      now: () => Number.MAX_SAFE_INTEGER + 1
    })).rejects.toThrowError(RangeError);
  });

  it("observes queued cancellation even when resize would otherwise be a no-op", async () => {
    const source = snapshot(makePng(2, 2));
    const controller = new AbortController();
    setImmediate(() => {
      controller.abort();
    });

    await expect(downscaleImage(
      source,
      { maxWidth: 4, maxHeight: 4, maxPixels: 16 },
      { signal: controller.signal }
    )).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("does not trust overridden or proxied AbortSignal aborted accessors", async () => {
    const source = snapshot(makePng(2, 2));

    const proxiedController = new AbortController();
    proxiedController.abort();
    const proxiedSignal = new Proxy(proxiedController.signal, {
      get(target, property, receiver): unknown {
        if (property === "aborted") return false;
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      }
    });
    await expect(cropImage(
      source,
      { x: 0, y: 0, width: 1, height: 1 },
      { signal: proxiedSignal }
    )).rejects.toThrowError(TypeError);

    const mutatedController = new AbortController();
    const mutatedSignal = mutatedController.signal;
    const originalPrototype = Object.getPrototypeOf(mutatedSignal);
    const lyingPrototype = Object.create(originalPrototype, {
      aborted: {
        configurable: true,
        get() {
          return false;
        }
      }
    });
    Object.setPrototypeOf(mutatedSignal, lyingPrototype);
    mutatedController.abort();

    await expect(cropImage(
      source,
      { x: 0, y: 0, width: 1, height: 1 },
      { signal: mutatedSignal }
    )).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("observes an abort already queued while a synchronous codec boundary is running", async () => {
    const source = snapshot(makePng(4, 4));
    const controller = new AbortController();
    setImmediate(() => {
      controller.abort();
    });

    await expect(cropImage(
      source,
      { x: 0, y: 0, width: 1, height: 1 },
      { signal: controller.signal }
    )).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("does not invoke caller timing callbacks for work already cancelled", async () => {
    const source = snapshot(makePng(2, 2));
    const controller = new AbortController();
    controller.abort();
    let clockCalls = 0;

    await expect(cropImage(source, { x: 0, y: 0, width: 1, height: 1 }, {
      signal: controller.signal,
      now: () => {
        clockCalls += 1;
        return 1;
      }
    })).rejects.toMatchObject({ code: "CANCELLED" });

    expect(clockCalls).toBe(0);
  });

  it("honors cancellation before work and during longer pixel loops", async () => {
    const source = snapshot(makePng(256, 256));
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(cropImage(source, { x: 0, y: 0, width: 128, height: 128 }, {
      signal: alreadyCancelled.signal
    })).rejects.toMatchObject({ code: "CANCELLED" });

    const controller = new AbortController();
    const work = downscaleImage(source, { maxWidth: 128, maxHeight: 128, maxPixels: 16_384 }, {
      signal: controller.signal
    });
    setImmediate(() => controller.abort());
    await expect(work).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("does not starve cancellation across many tiny tiles", async () => {
    const source = snapshot(makePng(128, 8));
    const controller = new AbortController();
    const work = tileImage(source, {
      tileWidth: 1,
      tileHeight: 8,
      overlap: 0,
      maxTileCount: 128
    }, { signal: controller.signal });
    setImmediate(() => controller.abort());
    await expect(work).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("rechecks cancellation after caller-supplied diagnostic timing", async () => {
    const source = snapshot(makePng(4, 4));
    const controller = new AbortController();
    let calls = 0;
    await expect(cropImage(source, { x: 0, y: 0, width: 2, height: 2 }, {
      signal: controller.signal,
      now: () => {
        calls += 1;
        if (calls === 2) controller.abort();
        return calls;
      }
    })).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("vision runtime schema boundaries", () => {
  it("makes the exported diagnostics schema use the same own-property boundary as the factory", () => {
    const inherited = Object.create({
      operation: "CROP",
      sourceDimensions: { width: 1, height: 1 },
      outputDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: 1,
      cropCount: 1,
      tileCount: 0,
      durationMs: 1,
      outcome: "SUCCESS"
    });
    expect(VisionProcessingDiagnosticsSchema.safeParse(inherited).success).toBe(false);

    let getterCalls = 0;
    const withUnknownGetter: Record<string, unknown> = {
      operation: "CROP",
      sourceDimensions: { width: 1, height: 1 },
      outputDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: 1,
      cropCount: 1,
      tileCount: 0,
      durationMs: 1,
      outcome: "SUCCESS"
    };
    Object.defineProperty(withUnknownGetter, "rawImage", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "should-not-run";
      }
    });
    expect(VisionProcessingDiagnosticsSchema.safeParse(withUnknownGetter).success).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("rejects inherited diagnostics fields instead of trusting the prototype chain", () => {
    const inherited = Object.create({
      operation: "CROP",
      sourceDimensions: { width: 1, height: 1 },
      outputDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: 1,
      cropCount: 1,
      tileCount: 0,
      durationMs: 1,
      outcome: "SUCCESS"
    });
    expect(() => createVisionProcessingDiagnostics(
      inherited as Parameters<typeof createVisionProcessingDiagnostics>[0]
    )).toThrow();
  });

  it("rejects inherited or hostile nested diagnostic dimensions", () => {
    const inheritedDimensions = Object.create({ width: 1, height: 1 });
    expect(() => createVisionProcessingDiagnostics({
      operation: "CROP",
      sourceDimensions: inheritedDimensions as { width: number; height: number },
      outputDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: 1,
      cropCount: 1,
      tileCount: 0,
      durationMs: 1,
      outcome: "SUCCESS"
    })).toThrow();

    const hostileDimensions = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile nested dimensions");
      }
    });
    expect(() => createVisionProcessingDiagnostics({
      operation: "CROP",
      sourceDimensions: hostileDimensions as { width: number; height: number },
      outputDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: 1,
      cropCount: 1,
      tileCount: 0,
      durationMs: 1,
      outcome: "SUCCESS"
    })).toThrow(TypeError);
  });

  it("bounds generic object-field enumeration before validation", () => {
    const diagnostics: Record<string, unknown> = {};
    for (let index = 0; index < 65; index += 1) {
      diagnostics[`extra${String(index)}`] = index;
    }
    expect(() => createVisionProcessingDiagnostics(
      diagnostics as unknown as Parameters<typeof createVisionProcessingDiagnostics>[0]
    )).toThrow();
  });

  it("rejects invalid preprocessing error codes at runtime", () => {
    expect(() => new VisionPreprocessingError(
      "NOT_A_REAL_VISION_ERROR" as never,
      "invalid"
    )).toThrow();
  });
});

describe("vision diagnostics validation", () => {
  it("rejects oversized unknown field names before evaluating their getters", () => {
    let getterCalls = 0;
    const diagnostic: Record<string, unknown> = {
      operation: "CROP",
      sourceDimensions: { width: 1, height: 1 },
      outputDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: 1,
      cropCount: 1,
      tileCount: 0,
      durationMs: 1,
      outcome: "SUCCESS"
    };
    Object.defineProperty(diagnostic, "x".repeat(100_000), {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      }
    });

    expect(() => createVisionProcessingDiagnostics(
      diagnostic as unknown as Parameters<typeof createVisionProcessingDiagnostics>[0]
    )).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("rejects unknown diagnostic getters without executing them", () => {
    let getterCalls = 0;
    const diagnostic: Record<string, unknown> = {
      operation: "CROP",
      sourceDimensions: { width: 1, height: 1 },
      outputDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: 1,
      cropCount: 1,
      tileCount: 0,
      durationMs: 1,
      outcome: "SUCCESS"
    };
    Object.defineProperty(diagnostic, "rawImage", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return Buffer.alloc(1);
      }
    });

    expect(() => createVisionProcessingDiagnostics(
      diagnostic as unknown as Parameters<typeof createVisionProcessingDiagnostics>[0]
    )).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("rejects unknown fields and unsafe durations instead of silently dropping them", () => {
    expect(() => createVisionProcessingDiagnostics({
      operation: "CROP",
      sourceDimensions: { width: 1, height: 1 },
      outputDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: 1,
      cropCount: 1,
      tileCount: 0,
      durationMs: 1,
      outcome: "SUCCESS",
      rawImage: "must-not-be-accepted"
    } as unknown as Parameters<typeof createVisionProcessingDiagnostics>[0])).toThrow();

    expect(() => createVisionProcessingDiagnostics({
      operation: "CROP",
      sourceDimensions: { width: 1, height: 1 },
      outputDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: 1,
      cropCount: 1,
      tileCount: 0,
      durationMs: Number.MAX_SAFE_INTEGER + 1,
      outcome: "SUCCESS"
    })).toThrow();
  });
});

  it("rejects diagnostics that exceed package byte or image dimension caps", () => {
    expect(() => createVisionProcessingDiagnostics({
      operation: "CROP",
      sourceDimensions: {
        width: HARD_IMAGE_VALIDATION_LIMITS.maxWidth + 1,
        height: 1
      },
      inputBytes: 1,
      outputBytes: 0,
      cropCount: 0,
      tileCount: 0,
      durationMs: 1,
      outcome: "FAILURE"
    })).toThrow();

    expect(() => createVisionProcessingDiagnostics({
      operation: "CROP",
      sourceDimensions: { width: 1, height: 1 },
      outputDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes + 1,
      cropCount: 1,
      tileCount: 0,
      durationMs: 1,
      outcome: "SUCCESS"
    })).toThrow();

    expect(() => createVisionProcessingDiagnostics({
      operation: "TILE",
      sourceDimensions: { width: 1, height: 1 },
      inputBytes: HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes + 1,
      outputBytes: 1,
      cropCount: 0,
      tileCount: 1,
      durationMs: 1,
      outcome: "FAILURE"
    })).toThrow();
  });

  it("rejects successful crop/resize diagnostics that exceed source dimensions", () => {
    const base = {
      sourceDimensions: { width: 2, height: 2 },
      inputBytes: 10,
      outputBytes: 10,
      durationMs: 1,
      outcome: "SUCCESS" as const
    };

    expect(() => createVisionProcessingDiagnostics({
      ...base,
      operation: "CROP",
      outputDimensions: { width: 3, height: 1 },
      cropCount: 1,
      tileCount: 0
    })).toThrow();

    expect(() => createVisionProcessingDiagnostics({
      ...base,
      operation: "RESIZE",
      outputDimensions: { width: 2, height: 3 },
      cropCount: 0,
      tileCount: 0
    })).toThrow();
  });

  it("bounds diagnostics counts to work this package can actually perform", () => {
    expect(() => createVisionProcessingDiagnostics({
      operation: "TILE",
      sourceDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: 1,
      cropCount: 0,
      tileCount: 513,
      durationMs: 1,
      outcome: "FAILURE"
    })).toThrow();

    expect(() => createVisionProcessingDiagnostics({
      operation: "CROP",
      sourceDimensions: { width: 1, height: 1 },
      inputBytes: 1,
      outputBytes: 1,
      cropCount: 2,
      tileCount: 0,
      durationMs: 1,
      outcome: "FAILURE"
    })).toThrow();
  });

  it("rejects semantically impossible successful diagnostics", () => {
    const base = {
      sourceDimensions: { width: 1, height: 1 },
      inputBytes: 10,
      outputBytes: 10,
      durationMs: 1,
      outcome: "SUCCESS" as const
    };

    expect(() => createVisionProcessingDiagnostics({
      ...base,
      operation: "CROP",
      outputDimensions: { width: 1, height: 1 },
      cropCount: 0,
      tileCount: 0
    })).toThrow();

    expect(() => createVisionProcessingDiagnostics({
      ...base,
      operation: "RESIZE",
      cropCount: 0,
      tileCount: 0
    })).toThrow();

    expect(() => createVisionProcessingDiagnostics({
      ...base,
      operation: "TILE",
      cropCount: 0,
      tileCount: 0
    })).toThrow();

    expect(() => createVisionProcessingDiagnostics({
      ...base,
      operation: "CROP",
      outputDimensions: { width: 1, height: 1 },
      inputBytes: 0,
      cropCount: 1,
      tileCount: 0
    })).toThrow();
  });

describe("provider-neutral request preparation and budgeting", () => {
  it("retains revision, dimensions, coordinate transform, and a non-serializing safe payload reference", async () => {
    const source = snapshot(makePng(6, 4), { revision: 21 });
    const crop = await cropImage(source, { x: 2, y: 1, width: 3, height: 2 });
    const request = prepareVisionImageRequest(crop.artifact, "WHITEBOARD_ANALYSIS");

    expect(request).toMatchObject({
      purpose: "WHITEBOARD_ANALYSIS",
      sourceRevision: 21,
      sourceSnapshotId: "snapshot-1",
      imageKind: "CROP",
      width: 3,
      height: 2,
      coordinateTransform: { offsetX: 2, offsetY: 1, scaleX: 1, scaleY: 1 }
    });
    expect(requestPayloadIsSafeReference(request)).toBe(true);
    expect(Object.isFrozen(request.payload)).toBe(true);
    expect(Buffer.from(request.payload.readBytes()).equals(Buffer.from(crop.artifact.readBytes()))).toBe(true);
    const callerCopy = request.payload.readBytes();
    callerCopy.fill(0);
    expect(sha256ImageBytes(request.payload.readBytes())).toBe(crop.artifact.metadata.contentDigest);
    const encodedBase64 = Buffer.from(crop.artifact.readBytes()).toString("base64");
    expect(JSON.stringify(request.payload)).not.toContain(encodedBase64);
    expect(JSON.stringify(request)).not.toContain(encodedBase64);
    expect(JSON.stringify(prepareVisionBatch([crop.artifact], "context"))).not.toContain(encodedBase64);

    const serializedRequest = JSON.parse(JSON.stringify(request)) as {
      readonly payload: Record<string, unknown>;
    };
    expect(serializedRequest.payload).toEqual(request.payload.metadata);
    expect(Object.keys(serializedRequest.payload).sort()).toEqual([
      "byteSize",
      "contentDigest",
      "height",
      "imageIdentity",
      "mimeType",
      "width"
    ]);
  });

  it("rejects inherited or accessor-backed payload references in the exported guard", () => {
    const source = snapshot(makePng(1, 1));
    const prepared = prepareVisionImageRequest(source, "guard");

    const inherited = Object.create({ payload: prepared.payload });
    expect(requestPayloadIsSafeReference(inherited)).toBe(false);

    const accessor = Object.defineProperty({}, "payload", {
      enumerable: true,
      get() {
        return prepared.payload;
      }
    });
    expect(requestPayloadIsSafeReference(accessor)).toBe(false);

    expect(requestPayloadIsSafeReference({ payload: prepared.payload })).toBe(true);
  });

  it("fails closed instead of throwing through hostile payload proxy traps", () => {
    const hostile = new Proxy({}, {
      has() {
        throw new Error("hostile has trap");
      }
    });
    expect(requestPayloadIsSafeReference(hostile)).toBe(false);
  });

  it("recognizes only validated crop/tile artifacts in the public artifact guard", async () => {
    const source = snapshot(makePng(4, 4));
    const crop = (await cropImage(source, { x: 0, y: 0, width: 2, height: 2 })).artifact;
    const resize = await downscaleImage(source, { maxWidth: 2, maxHeight: 2, maxPixels: 4 });
    const tiled = await tileImage(source, {
      tileWidth: 2,
      tileHeight: 2,
      overlap: 0,
      maxTileCount: 4
    });
    const firstTile = tiled.tiles[0]?.artifact;
    if (firstTile === undefined) throw new Error("Expected a generated tile");

    expect(isCropOrTileArtifact(source)).toBe(false);
    expect(isCropOrTileArtifact(crop)).toBe(true);
    expect(isCropOrTileArtifact(resize.image)).toBe(false);
    expect(isCropOrTileArtifact(firstTile)).toBe(true);
    expect(isCropOrTileArtifact({ metadata: { kind: "CROP" } })).toBe(false);
  });

  it("accepts maximum-length and heavily escaped snapshot IDs with fixed bounded raster identities", () => {
    for (const id of ["s".repeat(128), "\u0000".repeat(128)]) {
      const source = snapshot(makePng(2, 2), { id, revision: 6 });
      const request = prepareVisionImageRequest(source, "context");
      expect(request.imageIdentity).toMatch(/^raster_[0-9a-f]{64}$/u);
      expect(request.payload.metadata.imageIdentity).toBe(request.imageIdentity);
    }
  });

  it("keeps snapshot image identities distinct across source revisions even when ID and bytes are reused", () => {
    const bytes = makePng(3, 3);
    const first = snapshot(bytes, { id: "reused-id", revision: 6 });
    const second = snapshot(bytes, { id: "reused-id", revision: 7 });

    expect(prepareVisionImageRequest(first, "context").imageIdentity)
      .not.toBe(prepareVisionImageRequest(second, "context").imageIdentity);
    expect(revisionImageProcessingKey(first)).not.toBe(revisionImageProcessingKey(second));
  });

  it("creates stable request identities for repeatable preparation", () => {
    const source = snapshot(makePng(3, 3), { revision: 6 });
    expect(prepareVisionImageRequest(source, "context").requestId)
      .toBe(prepareVisionImageRequest(source, "context").requestId);
  });

  it("rejects subclasses that inherit the private brand but override validated byte access", () => {
    const goodBytes = makePng(2, 2);
    const base = snapshot(goodBytes);

    class EvilSnapshot extends ImageSnapshot {
      public override readBytes(): Buffer {
        return Buffer.from("not-a-png");
      }
    }

    const evil = new EvilSnapshot(
      INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION,
      base.metadata,
      goodBytes
    );
    expect(() => prepareVisionImageRequest(evil, "analysis"))
      .toThrowError(VisionPreprocessingError);
    expect(Object.isFrozen(ImageSnapshot.prototype)).toBe(true);
    expect(Object.isFrozen(ImageSnapshot)).toBe(true);
  });

  it("fails closed instead of throwing on hostile byte-match candidates", async () => {
    const source = snapshot(makePng(2, 2));
    const crop = (await cropImage(source, { x: 0, y: 0, width: 1, height: 1 })).artifact;
    const proxiedBytes = new Proxy(new Uint8Array([1, 2, 3]), {});
    const revoked = Proxy.revocable(new Uint8Array([1, 2, 3]), {});
    revoked.revoke();

    expect(source.matchesEncodedBytes(proxiedBytes)).toBe(false);
    expect(source.matchesEncodedBytes(revoked.proxy)).toBe(false);
    expect(crop.matchesEncodedBytes(proxiedBytes)).toBe(false);
    expect(crop.matchesEncodedBytes(revoked.proxy)).toBe(false);
  });

  it("maps revoked or hostile raster proxies to clean invalid-image failures", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(() => prepareVisionImageRequest(
      revocable.proxy as unknown as ImageSnapshot,
      "analysis"
    )).toThrowError(VisionPreprocessingError);
    expect(isCropOrTileArtifact(revocable.proxy)).toBe(false);
  });

  it("rejects prototype-forged raster instances that never ran a validating constructor", () => {
    const real = snapshot(makePng(2, 2));
    const forged = Object.create(ImageSnapshot.prototype) as Record<string, unknown>;
    Object.defineProperty(forged, "metadata", { value: real.metadata, enumerable: true });
    Object.defineProperty(forged, "readBytes", { value: () => real.readBytes() });

    expect(() => prepareVisionImageRequest(forged as unknown as ImageSnapshot, "analysis"))
      .toThrowError(VisionPreprocessingError);
  });

  it("rejects structurally similar but non-validated raster objects at runtime", async () => {
    const real = snapshot(makePng(2, 2));
    const fake = {
      metadata: real.metadata,
      readBytes: () => real.readBytes()
    } as unknown as ImageSnapshot;

    expect(() => prepareVisionImageRequest(fake, "analysis"))
      .toThrowError(VisionPreprocessingError);
    await expect(cropImage(fake, { x: 0, y: 0, width: 1, height: 1 }))
      .rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it("snapshots batch candidate accessors once before bounded-prefix budgeting", () => {
    const first = snapshot(makePng(2, 2), { id: "first-candidate", revision: 4 });
    const second = snapshot(makePng(2, 2), { id: "second-candidate", revision: 4 });
    let reads = 0;
    const candidates: ImageSnapshot[] = [];
    Object.defineProperty(candidates, "0", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? first : second;
      }
    });
    Object.defineProperty(candidates, "length", { value: 1 });

    const batch = prepareVisionBatch(candidates, "analysis", {
      maxImages: 0,
      maxTotalBytes: 0,
      maxTotalPixels: 0,
      maxCropsOrTiles: 0
    }, "BOUNDED_PREFIX");

    expect(reads).toBe(1);
    expect(batch.deferredImageIdentities).toEqual([
      prepareVisionImageRequest(first, "analysis").imageIdentity
    ]);
  });

  it("supports a zero request budget with explicit bounded-prefix deferral", () => {
    const source = snapshot(makePng(2, 2));
    const batch = prepareVisionBatch([source], "analysis", {
      maxImages: 0,
      maxTotalBytes: 0,
      maxTotalPixels: 0,
      maxCropsOrTiles: 0
    }, "BOUNDED_PREFIX");
    expect(batch.requests).toEqual([]);
    expect(batch.deferredImageIdentities).toEqual([prepareVisionImageRequest(source, "analysis").imageIdentity]);
    expect(batch.totals).toEqual({ images: 0, totalBytes: 0, totalPixels: 0, cropsOrTiles: 0 });
    expect(batch.truncated).toBe(true);

    expect(() => prepareVisionBatch([source], "analysis", {
      maxImages: 0,
      maxTotalBytes: 0,
      maxTotalPixels: 0,
      maxCropsOrTiles: 0
    }, "FAIL")).toThrowError(VisionPreprocessingError);
  });

  it("validates batch purpose even when the candidate list is empty", () => {
    expect(() => prepareVisionBatch([], "invalid purpose with spaces"))
      .toThrow();
  });

  it("fails closed when a batch exceeds image/byte/pixel/crop budgets", async () => {
    const source = snapshot(makePng(8, 8));
    const cropA = (await cropImage(source, { x: 0, y: 0, width: 4, height: 4 })).artifact;
    const cropB = (await cropImage(source, { x: 4, y: 0, width: 4, height: 4 })).artifact;

    expect(() => prepareVisionBatch([cropA, cropB], "analysis", {
      maxImages: 1,
      maxTotalBytes: 1_000_000,
      maxTotalPixels: 1_000_000,
      maxCropsOrTiles: 10
    })).toThrowError(VisionPreprocessingError);

    expect(() => prepareVisionBatch([cropA], "analysis", {
      maxImages: 10,
      maxTotalBytes: cropA.metadata.byteSize - 1,
      maxTotalPixels: 1_000_000,
      maxCropsOrTiles: 10
    })).toThrowError(VisionPreprocessingError);

    expect(() => prepareVisionBatch([cropA], "analysis", {
      maxImages: 10,
      maxTotalBytes: 1_000_000,
      maxTotalPixels: 15,
      maxCropsOrTiles: 10
    })).toThrowError(VisionPreprocessingError);

    expect(() => prepareVisionBatch([cropA], "analysis", {
      maxImages: 10,
      maxTotalBytes: 1_000_000,
      maxTotalPixels: 1_000_000,
      maxCropsOrTiles: 0
    })).toThrowError(VisionPreprocessingError);
  });

  it("rejects inherited request candidates instead of trusting the prototype chain", () => {
    const source = snapshot(makePng(1, 1));
    const inherited = new Array<ImageSnapshot>(1);
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, "0", { value: source, enumerable: true });
    Object.setPrototypeOf(inherited, prototype);

    try {
      prepareVisionBatch(inherited, "analysis");
      throw new Error("Expected inherited candidate rejection");
    } catch (error) {
      expectCode(error, "INVALID_IMAGE");
    }
  });

  it("fails closed on hostile request candidate entry access", () => {
    const candidates: ImageSnapshot[] = [];
    Object.defineProperty(candidates, "0", {
      enumerable: true,
      get() {
        throw new Error("hostile request entry");
      }
    });
    Object.defineProperty(candidates, "length", { value: 1 });
    expect(() => prepareVisionBatch(candidates, "analysis")).toThrowError(TypeError);
  });

  it("maps hostile candidate length access to a clean invalid-image failure", () => {
    const hostile = new Proxy([] as ImageSnapshot[], {
      get(target, property, receiver): unknown {
        if (property === "length") throw new Error("hostile length trap");
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      }
    });
    try {
      prepareVisionBatch(hostile, "analysis");
      throw new Error("Expected hostile candidate rejection");
    } catch (error) {
      expectCode(error, "INVALID_IMAGE");
    }
  });

  it("rejects oversized candidate lists before budgeting or payload preparation", () => {
    const source = snapshot(makePng(1, 1));
    expect(() => prepareVisionBatch(
      Array.from({ length: 1025 }, () => source),
      "analysis"
    )).toThrowError(VisionPreprocessingError);
  });

  it("rejects inherited request-budget fields instead of trusting the prototype chain", () => {
    const inheritedBudget = Object.create({
      maxImages: 1,
      maxTotalBytes: 1_000_000,
      maxTotalPixels: 1_000_000,
      maxCropsOrTiles: 1
    });
    expect(() => prepareVisionBatch(
      [],
      "analysis",
      inheritedBudget as Parameters<typeof prepareVisionBatch>[2]
    )).toThrowError(RangeError);
  });

  it("fails closed on hostile request budget objects", () => {
    const hostileBudget = new Proxy({}, {
      get() {
        throw new Error("hostile budget getter");
      }
    });
    expect(() => prepareVisionBatch(
      [],
      "analysis",
      hostileBudget as unknown as Parameters<typeof prepareVisionBatch>[2]
    )).toThrowError(RangeError);
  });

  it("rejects hard image/crop budget overconfiguration and unknown budget keys", () => {
    expect(() => prepareVisionBatch([], "analysis", {
      maxImages: 257,
      maxTotalBytes: 1,
      maxTotalPixels: 1,
      maxCropsOrTiles: 0
    })).toThrow();

    expect(() => prepareVisionBatch([], "analysis", {
      maxImages: 1,
      maxTotalBytes: 1,
      maxTotalPixels: 1,
      maxCropsOrTiles: 257
    })).toThrow();

    expect(() => prepareVisionBatch([], "analysis", {
      maxImages: 1,
      maxTotalBytes: 1,
      maxTotalPixels: 1,
      maxCropsOrTiles: 0,
      maxImagez: 1
    } as unknown as Parameters<typeof prepareVisionBatch>[2])).toThrow();
  });

  it("rejects attempts to configure request budgets above package hard ceilings", () => {
    expect(() => prepareVisionBatch([], "analysis", {
      maxImages: 1,
      maxTotalBytes: 128 * 1024 * 1024 + 1,
      maxTotalPixels: 1,
      maxCropsOrTiles: 0
    })).toThrow();
    expect(() => prepareVisionBatch([], "analysis", {
      maxImages: 1,
      maxTotalBytes: 1,
      maxTotalPixels: 128 * 1024 * 1024 + 1,
      maxCropsOrTiles: 0
    })).toThrow();
  });

  it("can return an explicit bounded prefix and all deferred identities instead of silently over-batching", async () => {
    const source = snapshot(makePng(12, 4));
    const tiles = await tileImage(source, {
      tileWidth: 4,
      tileHeight: 4,
      overlap: 0,
      maxTileCount: 3
    });
    const batch = prepareVisionBatch(
      tiles.tiles.map((tile) => tile.artifact),
      "analysis",
      {
        maxImages: 2,
        maxTotalBytes: 1_000_000,
        maxTotalPixels: 1_000_000,
        maxCropsOrTiles: 2
      },
      "BOUNDED_PREFIX"
    );
    expect(batch.requests).toHaveLength(2);
    expect(batch.deferredImageIdentities).toHaveLength(1);
    expect(batch.truncated).toBe(true);
    expect(batch.totals).toMatchObject({ images: 2, cropsOrTiles: 2, totalPixels: 32 });
  });
});
