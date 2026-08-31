import {
  type Editor,
  type TLShape,
  type TLShapeId,
  type TLShapePartial,
  createShapeId,
  renderPlaintextFromRichText,
  toRichText
} from "tldraw";
import type {
  TLShapeBounds,
  TLShapePartialRecord,
  TLShapeRecord,
  TldrawEditor
} from "../tldraw-whiteboard-adapter.js";
import {
  isStudentOwnedShape,
  normalizeStudentShape,
  type NormalizedStudentMutationSource,
  type NormalizedStudentShapeChange
} from "./normalized-board.js";

const STUDENT_LAYER = "STUDENT";
const AI_LAYER = "AI_ANNOTATION";
const SYSTEM_LAYER = "SYSTEM_DECORATION";
const ADAPTER_MUTATION_TOKEN = "__interviewAdapterStudentMutation";

function toShapeId(id: string): TLShapeId {
  return (id.startsWith("shape:") ? id : createShapeId(id)) as TLShapeId;
}

export interface RealTldrawEditorOptions {
  /** Retained for source compatibility; BoardRevision is no longer owned here. */
  readonly initialBoardRevision?: number;
  /** Admission-only check owned by the authoritative adapter revision counter. */
  readonly assertStudentMutationCanAdvance?: () => void;
}

/**
 * Frontend-only bridge from the real tldraw Editor to the application's existing
 * whiteboard adapter contract. Raw tldraw records never need to leak into future
 * synchronization code; subscribeToNormalizedStudentChanges is the intended seam.
 *
 * BoardRevision deliberately does not live in this class. Adapter-originated
 * student changes receive an internal transaction token so store-listener timing
 * cannot cause them to be counted again as direct editor changes.
 */
export class RealTldrawEditorBridge implements TldrawEditor {
  private protectedMutationDepth = 0;
  private nextAdapterMutationToken = 1;
  private readonly normalizedSubscribers = new Set<
    (change: NormalizedStudentShapeChange) => void
  >();
  private normalizedStoreUnlisten: (() => void) | undefined;
  private readonly pendingAdapterMutationTokens = new Set<number>();
  private readonly pendingAdapterDeleteIds = new Set<string>();

  public constructor(
    private readonly nativeEditor: Editor,
    private readonly options: RealTldrawEditorOptions = {}
  ) {}

  public getNativeEditor(): Editor {
    return this.nativeEditor;
  }

  public getShape(id: string): TLShapeRecord | undefined {
    const shape = this.nativeEditor.getShape(toShapeId(id));
    return shape === undefined ? undefined : this.toLegacyShape(shape);
  }

  public getCurrentPageShapes(): readonly TLShapeRecord[] {
    return this.nativeEditor.getCurrentPageShapes().map((shape) => this.toLegacyShape(shape));
  }

  public createShapes(shapes: readonly TLShapePartialRecord[]): void {
    for (const shape of shapes) this.assertValidPartialOwnership(shape);
    const hasStudentMutation = shapes.some((shape) =>
      effectivePartialLayer(shape) === STUDENT_LAYER
    );
    const protectedOnly = shapes.length > 0 && !hasStudentMutation;
    const token = hasStudentMutation ? this.reserveAdapterMutationTokenIfObserved() : undefined;
    const nativeShapes = shapes.map((shape) => this.toNativePartial(
      token === undefined || isProtectedLayer(shape.meta?.["layer"])
        ? shape
        : withAdapterMutationToken(shape, token)
    ));

    try {
      this.runAdapterMutation(
        () => {
          this.nativeEditor.createShapes(nativeShapes);
        },
        protectedOnly
      );
    } catch (error) {
      if (token !== undefined) this.pendingAdapterMutationTokens.delete(token);
      throw error;
    }
  }

  public deleteShapes(ids: readonly string[]): void {
    const classified = ids.map((id) => {
      const shape = this.nativeEditor.getShape(toShapeId(id));
      return {
        id,
        shape,
        layer: shape === undefined ? undefined : effectiveNativeLayer(shape)
      };
    });
    const protectedOnly = classified.length > 0 && classified.every(
      ({ layer }) => layer !== undefined && layer !== STUDENT_LAYER
    );
    const studentIds = protectedOnly
      ? []
      : classified
          .filter(({ layer }) => layer === STUDENT_LAYER)
          .map(({ id }) => id);
    if (this.normalizedSubscribers.size > 0) {
      for (const id of studentIds) this.pendingAdapterDeleteIds.add(id);
    }

    try {
      this.runAdapterMutation(
        () => {
          this.nativeEditor.deleteShapes(ids.map(toShapeId));
        },
        protectedOnly
      );
    } catch (error) {
      for (const id of studentIds) this.pendingAdapterDeleteIds.delete(id);
      throw error;
    }
  }

  public updateShapes(shapes: readonly TLShapePartialRecord[]): void {
    const ownership = shapes.map((shape) => {
      this.assertValidPartialOwnership(shape);
      const current = this.nativeEditor.getShape(toShapeId(shape.id));
      const currentLayer = current === undefined ? undefined : effectiveNativeLayer(current);
      const requestedLayer = effectivePartialLayer(shape, currentLayer);
      if (
        currentLayer !== undefined
        && requestedLayer !== currentLayer
      ) {
        throw new Error(
          `Whiteboard shape ownership layer cannot change from ${currentLayer} to ${requestedLayer}`
        );
      }
      return { shape, current, layer: requestedLayer };
    });

    const hasStudentMutation = ownership.some(({ layer }) => layer === STUDENT_LAYER);
    const protectedOnly = shapes.length > 0 && !hasStudentMutation;
    const token = hasStudentMutation ? this.reserveAdapterMutationTokenIfObserved() : undefined;
    const nativeShapes = ownership.map(({ shape, current, layer }) => {
      const mergedMeta = {
        ...(current === undefined ? {} : withoutAdapterMutationToken(metadata(current.meta))),
        ...shape.meta,
        layer,
        origin: originForLayer(layer)
      };
      const typedShape: TLShapePartialRecord = {
        ...shape,
        ...(shape.type === undefined && current !== undefined ? { type: current.type } : {}),
        meta: mergedMeta
      };
      if (token === undefined || layer !== STUDENT_LAYER) {
        return this.toNativePartial(typedShape);
      }
      return this.toNativePartial(withAdapterMutationToken(typedShape, token));
    });

    try {
      this.runAdapterMutation(
        () => {
          this.nativeEditor.updateShapes(nativeShapes);
        },
        protectedOnly
      );
    } catch (error) {
      if (token !== undefined) this.pendingAdapterMutationTokens.delete(token);
      throw error;
    }
  }

  public getShapePageBounds(idOrShape: string | TLShapeRecord): TLShapeBounds | undefined {
    const id = typeof idOrShape === "string" ? idOrShape : idOrShape.id;
    const bounds = this.nativeEditor.getShapePageBounds(toShapeId(id));
    if (bounds === undefined) return undefined;

    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.w,
      height: bounds.h,
      minX: bounds.x,
      minY: bounds.y,
      maxX: bounds.x + bounds.w,
      maxY: bounds.y + bounds.h
    };
  }

  public get store(): NonNullable<TldrawEditor["store"]> {
    return {
      listen: (listener) => this.nativeEditor.store.listen(
        (entry) => {
          listener(entry);
        },
        { source: "all", scope: "document" }
      ),
      allRecords: () => this.nativeEditor.store.allRecords()
    };
  }

  /**
   * Tags ordinary tldraw-created shapes as student work and makes protected
   * AI/system shapes immutable to normal canvas interactions. Adapter-owned
   * protected mutations pass through an explicit guarded section.
   */
  public installOwnershipGuards(): () => void {
    const cleanups: (() => void)[] = [];

    try {
      cleanups.push(
      this.nativeEditor.sideEffects.registerBeforeCreateHandler("shape", (shape, source) => {
        if (source !== "user" || this.protectedMutationDepth > 0) return shape;

        this.options.assertStudentMutationCanAdvance?.();
        const now = new Date().toISOString();
        const shapeMeta = withoutAdapterMutationToken(metadata(shape.meta));
        return {
          ...shape,
          isLocked: false,
          meta: {
            ...shapeMeta,
            layer: STUDENT_LAYER,
            origin: "STUDENT",
            shapeRevision: existingShapeRevision(shapeMeta["shapeRevision"]),
            createdAt: stringMeta(shapeMeta["createdAt"], now),
            lastModifiedAt: now
          }
        };
      })
    );

    cleanups.push(
      this.nativeEditor.sideEffects.registerBeforeChangeHandler("shape", (previous, next, source) => {
        if (source !== "user") return next;

        const previousMeta = metadata(previous.meta);
        const previousLayer = previousMeta["layer"];
        if (
          previousLayer !== undefined
          && previousLayer !== STUDENT_LAYER
          && this.protectedMutationDepth === 0
        ) {
          return previous;
        }

        if (this.protectedMutationDepth > 0) return next;

        this.options.assertStudentMutationCanAdvance?.();
        const nextMeta = withoutAdapterMutationToken(metadata(next.meta));
        const now = new Date().toISOString();
        const previousRevision = existingShapeRevision(previousMeta["shapeRevision"]);
        if (previousRevision >= Number.MAX_SAFE_INTEGER) {
          return previous;
        }
        return {
          ...next,
          meta: {
            ...nextMeta,
            layer: STUDENT_LAYER,
            origin: "STUDENT",
            shapeRevision: previousRevision + 1,
            createdAt: stringMeta(previousMeta["createdAt"], now),
            lastModifiedAt: now
          }
        };
      })
    );

      cleanups.push(
        this.nativeEditor.sideEffects.registerBeforeDeleteHandler("shape", (shape, source) => {
          if (source !== "user" || this.protectedMutationDepth > 0) return;
          const layer = metadata(shape.meta)["layer"];
          if (layer !== undefined && layer !== STUDENT_LAYER) return false;
          this.options.assertStudentMutationCanAdvance?.();
          return;
        })
      );
    } catch (error) {
      releaseOwnershipGuards(cleanups);
      throw error;
    }

    return () => {
      releaseOwnershipGuards(cleanups);
    };
  }

  public subscribeToNormalizedStudentChanges(
    listener: (change: NormalizedStudentShapeChange) => void
  ): () => void {
    this.normalizedSubscribers.add(listener);
    this.ensureNormalizedStoreListener();

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.normalizedSubscribers.delete(listener);
      if (this.normalizedSubscribers.size === 0) {
        this.normalizedStoreUnlisten?.();
        this.normalizedStoreUnlisten = undefined;
        this.pendingAdapterMutationTokens.clear();
        this.pendingAdapterDeleteIds.clear();
      }
    };
  }

  private ensureNormalizedStoreListener(): void {
    if (this.normalizedStoreUnlisten !== undefined) return;

    this.normalizedStoreUnlisten = this.nativeEditor.store.listen(
      (entry) => {
        const added = [];
        const updated = [];
        const deleted = [];
        const observedTokens = new Set<number>();
        const deletedStudentIds: string[] = [];
        let studentMutationCount = 0;
        let adapterAttributedStudentMutationCount = 0;

        for (const record of Object.values(entry.changes.added)) {
          if (record.typeName !== "shape") continue;
          collectAdapterMutationToken(record.meta, observedTokens);
          const normalized = this.normalizeNativeShape(record);
          if (normalized !== null) {
            added.push(normalized);
            studentMutationCount += 1;
            if (this.hasPendingAdapterMutationToken(record.meta)) {
              adapterAttributedStudentMutationCount += 1;
            }
          }
        }

        for (const pair of Object.values(entry.changes.updated)) {
          const beforeRecord = pair[0];
          const afterRecord = pair[1];
          if (beforeRecord.typeName !== "shape" || afterRecord.typeName !== "shape") continue;
          collectAdapterMutationToken(afterRecord.meta, observedTokens);

          const before = this.normalizeNativeShape(beforeRecord);
          const after = this.normalizeNativeShape(afterRecord);
          if (before !== null && after !== null) {
            updated.push({ before, after });
            studentMutationCount += 1;
            if (this.hasPendingAdapterMutationToken(afterRecord.meta)) {
              adapterAttributedStudentMutationCount += 1;
            }
          }
        }

        for (const record of Object.values(entry.changes.removed)) {
          if (record.typeName !== "shape") continue;
          collectAdapterMutationToken(record.meta, observedTokens);
          const normalized = this.normalizeNativeShape(record);
          if (normalized !== null) {
            deleted.push(normalized);
            deletedStudentIds.push(normalized.id);
            studentMutationCount += 1;
            if (
              this.hasPendingAdapterMutationToken(record.meta)
              || this.pendingAdapterDeleteIds.has(normalized.id)
            ) {
              adapterAttributedStudentMutationCount += 1;
            }
          }
        }

        if (added.length === 0 && updated.length === 0 && deleted.length === 0) return;

        const change: NormalizedStudentShapeChange = {
          source: this.consumeMutationSource(
            observedTokens,
            deletedStudentIds,
            studentMutationCount,
            adapterAttributedStudentMutationCount
          ),
          added,
          updated,
          deleted
        };
        for (const subscriber of [...this.normalizedSubscribers]) {
          try {
            subscriber(change);
          } catch {
            // Observers do not own the already-committed tldraw transaction.
            // Continue notifying other subscribers without reclassifying source.
          }
        }
      },
      { source: "all", scope: "document" }
    );
  }

  private normalizeNativeShape(shape: TLShape) {
    const legacy = this.toLegacyShape(shape);
    if (!isStudentOwnedShape(legacy)) return null;
    const bounds = this.getShapePageBounds(legacy) ?? fallbackBounds(legacy);
    return normalizeStudentShape(legacy, bounds);
  }

  private hasPendingAdapterMutationToken(meta: unknown): boolean {
    const token = adapterMutationToken(meta);
    return token !== undefined && this.pendingAdapterMutationTokens.has(token);
  }

  private reserveAdapterMutationTokenIfObserved(): number | undefined {
    if (this.normalizedSubscribers.size === 0) return undefined;
    if (
      !Number.isSafeInteger(this.nextAdapterMutationToken)
      || this.nextAdapterMutationToken < 1
      || this.nextAdapterMutationToken >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("Whiteboard adapter mutation token space is exhausted");
    }
    const token = this.nextAdapterMutationToken;
    this.nextAdapterMutationToken += 1;
    this.pendingAdapterMutationTokens.add(token);
    return token;
  }

  private consumeMutationSource(
    observedTokens: ReadonlySet<number>,
    deletedStudentIds: readonly string[],
    studentMutationCount: number,
    adapterAttributedStudentMutationCount: number
  ): NormalizedStudentMutationSource {
    for (const token of observedTokens) {
      this.pendingAdapterMutationTokens.delete(token);
    }
    for (const id of deletedStudentIds) {
      this.pendingAdapterDeleteIds.delete(id);
    }
    return studentMutationCount > 0
      && adapterAttributedStudentMutationCount === studentMutationCount
      ? "ADAPTER"
      : "EDITOR";
  }

  private assertValidPartialOwnership(shape: TLShapePartialRecord): void {
    const rawLayer = shape.meta?.["layer"];
    if (
      rawLayer !== undefined
      && rawLayer !== STUDENT_LAYER
      && rawLayer !== AI_LAYER
      && rawLayer !== SYSTEM_LAYER
    ) {
      throw new Error(`Whiteboard shape "${shape.id}" has an invalid ownership layer`);
    }

    const rawRevision = shape.meta?.["shapeRevision"];
    if (
      rawRevision !== undefined
      && (
        typeof rawRevision !== "number"
        || !Number.isSafeInteger(rawRevision)
        || rawRevision < 1
      )
    ) {
      throw new Error(`Whiteboard shape "${shape.id}" has an invalid shape revision`);
    }

    const rawOrigin = shape.meta?.["origin"];
    if (
      rawOrigin !== undefined
      && rawOrigin !== "STUDENT"
      && rawOrigin !== "AI"
      && rawOrigin !== "SYSTEM"
    ) {
      throw new Error(`Whiteboard shape "${shape.id}" has an invalid ownership origin`);
    }

    const layer = effectivePartialLayer(shape);
    const expectedOrigin = layer === STUDENT_LAYER
      ? "STUDENT"
      : layer === AI_LAYER
        ? "AI"
        : "SYSTEM";
    if (rawOrigin !== undefined && rawOrigin !== expectedOrigin) {
      throw new Error(
        `Whiteboard shape "${shape.id}" origin does not match ownership layer ${layer}`
      );
    }
  }

  private runAdapterMutation(operation: () => void, ignoreHistory: boolean): void {
    this.protectedMutationDepth += 1;
    try {
      this.nativeEditor.run(
        operation,
        ignoreHistory
          ? { ignoreShapeLock: true, history: "ignore" }
          : { ignoreShapeLock: true }
      );
    } finally {
      this.protectedMutationDepth -= 1;
    }
  }

  private toNativePartial(shape: TLShapePartialRecord): TLShapePartial {
    const layer = typeof shape.meta?.["layer"] === "string"
      ? shape.meta["layer"]
      : shape.isLocked
        ? AI_LAYER
        : STUDENT_LAYER;
    const origin = typeof shape.meta?.["origin"] === "string"
      ? shape.meta["origin"]
      : isProtectedLayer(layer)
        ? "AI"
        : "STUDENT";
    const meta = toNativeMeta(shape.meta, layer, origin);
    const nativeProps = legacyPropsToNative(shape.type, shape.props);

    return {
      id: toShapeId(shape.id),
      ...(shape.type !== undefined ? { type: shape.type } : {}),
      ...(shape.x !== undefined ? { x: shape.x } : {}),
      ...(shape.y !== undefined ? { y: shape.y } : {}),
      ...(shape.rotation !== undefined ? { rotation: shape.rotation } : {}),
      ...(shape.opacity !== undefined ? { opacity: shape.opacity } : {}),
      ...(shape.isLocked !== undefined
        ? { isLocked: shape.isLocked }
        : isProtectedLayer(layer)
          ? { isLocked: true }
          : {}),
      ...(nativeProps !== undefined ? { props: nativeProps } : {}),
      meta
    } as TLShapePartial;
  }

  private toLegacyShape(shape: TLShape): TLShapeRecord {
    const nativeProps = shape.props as Record<string, unknown>;
    const text = richTextToPlainText(this.nativeEditor, nativeProps["richText"]);
    const props = text === undefined ? { ...nativeProps } : { ...nativeProps, text };
    const shapeMeta = withoutAdapterMutationToken(metadata(shape.meta));
    const layer = effectiveNativeLayer(shape);
    const origin = originForLayer(layer);
    const now = new Date().toISOString();
    const meta = {
      ...shapeMeta,
      layer,
      origin,
      shapeRevision: positiveSafeRevision(shapeMeta["shapeRevision"], 1),
      createdAt: stringMeta(shapeMeta["createdAt"], now),
      lastModifiedAt: stringMeta(shapeMeta["lastModifiedAt"], now)
    };

    return {
      id: shape.id,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      rotation: shape.rotation,
      isLocked: shape.isLocked,
      opacity: shape.opacity,
      props,
      meta
    };
  }
}

function withAdapterMutationToken(shape: TLShapePartialRecord, token: number): TLShapePartialRecord {
  return {
    ...shape,
    meta: {
      ...shape.meta,
      [ADAPTER_MUTATION_TOKEN]: token
    }
  };
}

function collectAdapterMutationToken(meta: unknown, target: Set<number>): void {
  const token = metadata(meta)[ADAPTER_MUTATION_TOKEN];
  if (typeof token === "number" && Number.isSafeInteger(token) && token > 0) {
    target.add(token);
  }
}

function withoutAdapterMutationToken(meta: Record<string, unknown>): Record<string, unknown> {
  const result = { ...meta };
  delete result[ADAPTER_MUTATION_TOKEN];
  return result;
}

function legacyPropsToNative(
  type: string | undefined,
  props: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (props === undefined) return undefined;

  const nativeProps = { ...props };
  const text = nativeProps["text"];
  if (
    typeof text === "string"
    && (type === "geo" || type === "arrow" || type === "note" || type === "text")
    && nativeProps["richText"] === undefined
  ) {
    nativeProps["richText"] = toRichText(text);
    delete nativeProps["text"];
  }
  return nativeProps;
}

function richTextToPlainText(editor: Editor, richText: unknown): string | undefined {
  if (richText === undefined || richText === null || typeof richText !== "object") return undefined;
  try {
    return renderPlaintextFromRichText(
      editor,
      richText as Parameters<typeof renderPlaintextFromRichText>[1]
    );
  } catch {
    return undefined;
  }
}

function toNativeMeta(
  meta: Record<string, unknown> | undefined,
  layer: string,
  origin: string
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  if (meta !== undefined) {
    for (const [key, value] of Object.entries(meta)) {
      if (
        typeof value === "string"
        || typeof value === "boolean"
        || value === null
        || (typeof value === "number" && Number.isFinite(value))
      ) {
        result[key] = value;
      }
    }
  }

  const now = new Date().toISOString();
  result["layer"] = layer;
  result["origin"] = origin;
  result["shapeRevision"] = positiveSafeRevision(meta?.["shapeRevision"], 1);
  result["createdAt"] = stringMeta(meta?.["createdAt"], now);
  result["lastModifiedAt"] = stringMeta(meta?.["lastModifiedAt"], now);
  return result;
}

function metadata(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function originForLayer(
  layer: typeof STUDENT_LAYER | typeof AI_LAYER | typeof SYSTEM_LAYER
): "STUDENT" | "AI" | "SYSTEM" {
  if (layer === STUDENT_LAYER) return "STUDENT";
  if (layer === AI_LAYER) return "AI";
  return "SYSTEM";
}

function effectiveNativeLayer(shape: TLShape): typeof STUDENT_LAYER | typeof AI_LAYER | typeof SYSTEM_LAYER {
  const rawLayer = metadata(shape.meta)["layer"];
  if (rawLayer === STUDENT_LAYER || rawLayer === AI_LAYER || rawLayer === SYSTEM_LAYER) {
    return rawLayer;
  }
  if (rawLayer !== undefined) {
    // Unknown persisted ownership metadata is fail-closed as protected.
    return SYSTEM_LAYER;
  }
  return shape.isLocked ? AI_LAYER : STUDENT_LAYER;
}

function effectivePartialLayer(
  shape: TLShapePartialRecord,
  currentLayer?: typeof STUDENT_LAYER | typeof AI_LAYER | typeof SYSTEM_LAYER
): typeof STUDENT_LAYER | typeof AI_LAYER | typeof SYSTEM_LAYER {
  const rawLayer = shape.meta?.["layer"];
  if (rawLayer === STUDENT_LAYER || rawLayer === AI_LAYER || rawLayer === SYSTEM_LAYER) {
    return rawLayer;
  }
  if (currentLayer !== undefined) return currentLayer;
  return shape.isLocked ? AI_LAYER : STUDENT_LAYER;
}

function isProtectedLayer(value: unknown): boolean {
  return value === AI_LAYER || value === SYSTEM_LAYER;
}

function positiveSafeRevision(value: unknown, fallback: number): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    ? value
    : fallback;
}

function existingShapeRevision(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  throw new Error("Existing student shape has an invalid revision");
}

function releaseOwnershipGuards(cleanups: readonly (() => void)[]): void {
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    try {
      cleanups[index]?.();
    } catch {
      // Continue removing independently registered ownership side effects.
    }
  }
}

function stringMeta(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function fallbackBounds(shape: TLShapeRecord): TLShapeBounds {
  const props = shape.props ?? {};
  const width = numericProp(props["w"], numericProp(props["width"], 100));
  const height = numericProp(props["h"], numericProp(props["height"], 100));
  return {
    x: shape.x,
    y: shape.y,
    width,
    height,
    minX: shape.x,
    minY: shape.y,
    maxX: shape.x + width,
    maxY: shape.y + height
  };
}

function numericProp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
