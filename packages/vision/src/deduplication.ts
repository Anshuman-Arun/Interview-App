import { timingSafeEqual } from "node:crypto";
import { ImageSnapshot, VisionImageArtifact, type VisionRasterSource } from "./types.js";

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
  if (imageByteSize(left) !== imageByteSize(right) || imageDigest(left) !== imageDigest(right)) return false;
  const leftBytes = Buffer.from(left.readBytes());
  const rightBytes = Buffer.from(right.readBytes());
  return timingSafeEqual(leftBytes, rightBytes);
}

export function revisionImageProcessingKey(source: VisionRasterSource): string {
  return `${String(imageRevision(source))}:${imageDigest(source)}`;
}

export function cropPayloadKey(crop: VisionImageArtifact): string {
  return crop.metadata.contentDigest;
}

export function sameRevisionAndImage(left: VisionRasterSource, right: VisionRasterSource): boolean {
  return revisionImageProcessingKey(left) === revisionImageProcessingKey(right) && exactImagePayloadDuplicate(left, right);
}

export function deduplicateExactImagePayloads<T extends VisionRasterSource>(images: readonly T[]): readonly T[] {
  const buckets = new Map<string, T[]>();
  const unique: T[] = [];

  for (const image of images) {
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
  return source instanceof ImageSnapshot ? source.metadata.snapshotId : source.metadata.sourceSnapshotId;
}

export function imageIdentity(source: VisionRasterSource): string {
  if (source instanceof ImageSnapshot) {
    return `snapshot:${source.metadata.snapshotId}:${source.metadata.contentDigest}`;
  }
  return `artifact:${source.metadata.artifactId}:${source.metadata.contentDigest}`;
}
