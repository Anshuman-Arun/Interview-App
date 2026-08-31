import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { BoardRevisionSchema } from "../packages/domain/src/index.js";
import {
  ImageSnapshot,
  VisionPreprocessingError,
  assertRectWithinImage,
  clipRectToBounds,
  coalesceOverlappingRegions,
  createValidatedImageSnapshot,
  cropImage,
  cropPayloadKey,
  deduplicateExactImagePayloads,
  downscaleImage,
  exactImagePayloadDuplicate,
  expandRect,
  imageBounds,
  intersectRects,
  normalizeRect,
  planDirtyRegions,
  planDownscale,
  planImageTiles,
  prepareVisionBatch,
  prepareVisionImageRequest,
  rectArea,
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
    mimeType: "image/png",
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
      mimeType: "image/png",
      encoding: "PNG",
      byteSize: bytes.length
    });
    expect(value.metadata.contentDigest).toBe(sha256ImageBytes(bytes));
    expect(JSON.stringify(value)).not.toContain(bytes.toString("base64"));
  });

  it("copies input bytes so caller mutation cannot invalidate the stored digest", () => {
    const bytes = makePng(2, 2);
    const originalDigest = sha256ImageBytes(bytes);
    const value = snapshot(bytes);
    bytes.fill(0);
    expect(value.metadata.contentDigest).toBe(originalDigest);
    expect(sha256ImageBytes(value.readBytes())).toBe(originalDigest);
  });

  it("rejects forged metadata when public image containers are constructed directly", () => {
    const value = snapshot(makePng(2, 2));
    expect(() => new ImageSnapshot({
      ...value.metadata,
      contentDigest: "0".repeat(64)
    }, value.readBytes())).toThrowError(RangeError);
    expect(() => new ImageSnapshot({
      ...value.metadata,
      width: value.metadata.width + 1
    }, value.readBytes())).toThrowError(RangeError);
  });

  it("does not allow direct construction to bypass full PNG decoding", () => {
    const value = snapshot(makePng(2, 2));
    const truncated = value.readBytes().subarray(0, 29);
    expect(() => new ImageSnapshot({
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

  it("rejects non-byte payloads at the runtime boundary", () => {
    expect(() => createValidatedImageSnapshot({
      snapshotId: "runtime-bad-bytes",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(0),
      capturedAtMs: 0,
      mimeType: "image/png",
      encodedBytes: "not-bytes" as unknown as Uint8Array
    })).toThrowError(VisionPreprocessingError);
  });

  it("rejects malformed bytes and detectable MIME mismatch", () => {
    expect(() => snapshot(Buffer.from("not-a-png"))).toThrowError(VisionPreprocessingError);
    try {
      snapshot(Buffer.from("not-a-png"));
    } catch (error) {
      expectCode(error, "MIME_MISMATCH");
    }

    const bytes = makePng(1, 1);
    expect(() => createValidatedImageSnapshot({
      snapshotId: "bad-mime",
      sourceType: "BROWSER_SCREENSHOT",
      sourceRevision: BoardRevisionSchema.parse(0),
      capturedAtMs: 0,
      mimeType: "image/jpeg",
      encodedBytes: bytes
    })).toThrowError(VisionPreprocessingError);
  });

  it("rejects trailing bytes after IEND and APNG control chunks", () => {
    const trailing = Buffer.concat([makePng(2, 2), Buffer.from([0xde, 0xad])]);
    expect(() => snapshot(trailing)).toThrowError(VisionPreprocessingError);

    const base = makePng(2, 2);
    const ihdrEnd = 8 + 12 + 13;
    const apngChunk = Buffer.alloc(20);
    apngChunk.writeUInt32BE(8, 0);
    apngChunk.write("acTL", 4, "ascii");
    const animated = Buffer.concat([
      base.subarray(0, ihdrEnd),
      apngChunk,
      base.subarray(ihdrEnd)
    ]);
    expect(() => snapshot(animated)).toThrowError(VisionPreprocessingError);
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
      mimeType: "image/png",
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

  it("rejects unknown snapshot fields and misspelled validation limit keys", () => {
    const bytes = makePng(2, 2);
    expect(() => createValidatedImageSnapshot({
      snapshotId: "strict-input",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png",
      encodedBytes: bytes,
      unexpectedField: true
    } as unknown as Parameters<typeof createValidatedImageSnapshot>[0])).toThrowError(VisionPreprocessingError);

    expect(() => createValidatedImageSnapshot({
      snapshotId: "strict-limit",
      sourceType: "WHITEBOARD_SNAPSHOT",
      sourceRevision: BoardRevisionSchema.parse(1),
      capturedAtMs: 1,
      mimeType: "image/png",
      encodedBytes: bytes
    }, {
      maxEncodedBytes: bytes.length,
      maxWidth: 10,
      maxHeight: 10,
      maxPixels: 100,
      maxPixles: 1
    } as unknown as Parameters<typeof createValidatedImageSnapshot>[1])).toThrowError(RangeError);
  });

  it("identifies exact image payloads and repeated processing identities", () => {
    const bytes = makePng(3, 3);
    const first = snapshot(bytes, { id: "a", revision: 9 });
    const second = snapshot(bytes, { id: "b", revision: 9 });
    const third = snapshot(bytes, { id: "c", revision: 10 });
    const different = snapshot(makePng(3, 3, () => [255, 0, 0, 255]), { id: "d", revision: 9 });

    expect(exactImagePayloadDuplicate(first, second)).toBe(true);
    expect(sameRevisionAndImage(first, second)).toBe(true);
    expect(sameRevisionAndImage(first, third)).toBe(false);
    expect(exactImagePayloadDuplicate(first, different)).toBe(false);
    expect(revisionImageProcessingKey(first)).toBe(revisionImageProcessingKey(second));
    expect(deduplicateExactImagePayloads([first, second, different])).toEqual([first, different]);
  });
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

  it("validates dirty rectangles before configured over-count fallback", () => {
    expect(() => planDirtyRegions([
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 5, y: 5, width: -1, height: 2 }
    ], { width: 20, height: 20 }, {
      maxInputRegions: 1,
      maxRegionCount: 1
    })).toThrowError(VisionPreprocessingError);
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
      coordinateTransform: { offsetX: 1, offsetY: 1, scaleX: 1, scaleY: 1 }
    });
    expect(rgbaAt(result.artifact.readBytes(), 0, 0)).toEqual([10, 20, 7, 255]);
    expect(rgbaAt(result.artifact.readBytes(), 1, 1)).toEqual([20, 40, 7, 255]);
    expect(cropPayloadKey(result.artifact)).toBe(result.artifact.metadata.contentDigest);

    await expect(cropImage(source, { x: 3, y: 3, width: 2, height: 2 })).rejects.toMatchObject({ code: "OUT_OF_BOUNDS" });
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
      coordinateTransform: { offsetX: 0, offsetY: 0, scaleX: 2.5, scaleY: 2.5 }
    });

    const unchanged = await downscaleImage(source, { maxWidth: 200, maxHeight: 200, maxPixels: 100_000 });
    expect(unchanged.plan.resized).toBe(false);
    expect(unchanged.image).toBe(source);
  });

  it("uses premultiplied-alpha interpolation so transparent edges do not acquire dark halos", async () => {
    const source = snapshot(makePng(2, 1, (x) => x === 0
      ? [255, 255, 255, 255]
      : [0, 0, 0, 0]));
    const resized = await downscaleImage(source, { maxWidth: 1, maxHeight: 1, maxPixels: 1 });
    expect(rgbaAt(resized.image.readBytes(), 0, 0)).toEqual([255, 255, 255, 128]);
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

  it("rejects enormous standalone tile plans before materializing axis arrays", () => {
    expect(() => planImageTiles(
      { width: Number.MAX_SAFE_INTEGER, height: 1 },
      { tileWidth: 1, tileHeight: 1, overlap: 0, maxTileCount: 1 }
    )).toThrowError(VisionPreprocessingError);
  });

  it("rejects high-overlap tile plans whose duplicated raw pixel work exceeds the hard ceiling", () => {
    expect(() => planImageTiles(
      { width: 8192, height: 8192 },
      { tileWidth: 4096, tileHeight: 8192, overlap: 4000, maxTileCount: 50 }
    )).toThrowError(VisionPreprocessingError);
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
    expect(JSON.stringify(request.payload)).not.toContain(Buffer.from(crop.artifact.readBytes()).toString("base64"));
  });

  it("accepts maximum-length snapshot IDs without overflowing prepared payload identity metadata", () => {
    const source = snapshot(makePng(2, 2), { id: "s".repeat(128), revision: 6 });
    const request = prepareVisionImageRequest(source, "context");
    expect(request.imageIdentity.length).toBeGreaterThan(160);
    expect(request.payload.metadata.imageIdentity).toBe(request.imageIdentity);
  });

  it("creates stable request identities for repeatable preparation", () => {
    const source = snapshot(makePng(3, 3), { revision: 6 });
    expect(prepareVisionImageRequest(source, "context").requestId)
      .toBe(prepareVisionImageRequest(source, "context").requestId);
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
