import { timingSafeEqual } from "node:crypto";
import {
  ImageSnapshot,
  VisionImageArtifact,
  assertVisionRasterSource,
  type VisionRasterSource
} from "./types.js";

function imageDigest(source: VisionRasterSource): string {
  return source.metadata.contentDigest;
}

function imageByteSize(source: VisionRasterSource): number {
  return source.metadata.byteSize;
}

function imageRevision(source: VisionRasterSource): number {
  return source.metadata.sourceRevision;
}

export function exactImagePayloadDuplicate(left: VisionRasterSource, right: VisionRasterSource): boolean {
  assertVisionRasterSource(left);
  assertVisionRasterSource(right);
  if (imageByteSize(left) !== imageByteSize(right) || imageDigest(left) !== imageDigest(right)) return false;
  return timingSafeEqual(left.readBytes(), right.readBytes());
}

export function revisionImageProcessingKey(source: VisionRasterSource): string {
  assertVisionRasterSource(source);
  return JSON.stringify([
    sourceSnapshotId(source),
    imageRevision(source),
    imageDigest(source)
  ]);
}

export function cropPayloadKey(crop: VisionImageArtifact): string {
  assertVisionRasterSource(crop);
  if (!(crop instanceof VisionImageArtifact) || crop.metadata.kind !== "CROP") {
    throw new TypeError("cropPayloadKey requires a crop artifact");
  }
  return crop.metadata.contentDigest;
}

export function sameRevisionAndImage(left: VisionRasterSource, right: VisionRasterSource): boolean {
  return revisionImageProcessingKey(left) === revisionImageProcessingKey(right) && exactImagePayloadDuplicate(left, right);
}

export function deduplicateExactImagePayloads<T extends VisionRasterSource>(images: readonly T[]): readonly T[] {
  const buckets = new Map<string, T[]>();
  const unique: T[] = [];

  for (const image of images) {
    assertVisionRasterSource(image);
    const key = `${String(image.metadata.byteSize)}:${image.metadata.contentDigest}`;
    const bucket = buckets.get(key) ?? [];
    if (bucket.some((candidate) => exactImagePayloadDuplicate(candidate, image))) continue;
    bucket.push(image);
    buckets.set(key, bucket);
    unique.push(image);
  }

  return Object.freeze(unique);
}

export function sourceSnapshotId(source: VisionRasterSource): string {
  assertVisionRasterSource(source);
  return source instanceof ImageSnapshot ? source.metadata.snapshotId : source.metadata.sourceSnapshotId;
}

export function imageIdentity(source: VisionRasterSource): string {
  assertVisionRasterSource(source);
  if (source instanceof ImageSnapshot) {
    return `snapshot:${source.metadata.snapshotId}:${source.metadata.contentDigest}`;
  }
  return `artifact:${source.metadata.artifactId}:${source.metadata.contentDigest}`;
}
