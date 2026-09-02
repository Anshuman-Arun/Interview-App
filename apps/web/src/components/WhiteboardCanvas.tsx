import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite.js";
import { Tldraw, type Editor } from "tldraw";
import "tldraw/tldraw.css";
import {
  TldrawWhiteboardAdapter,
  type CanvasSnapshot,
  type TldrawEditor
} from "../tldraw-whiteboard-adapter.js";
import {
  RealTldrawEditorBridge
} from "../whiteboard/real-tldraw-editor.js";
import type {
  NormalizedStudentShapeChange
} from "../whiteboard/normalized-board.js";

const TLDRAW_ASSET_URLS = getAssetUrlsByImport();

export interface WhiteboardCanvasProps {
  readonly adapter?: TldrawWhiteboardAdapter;
  readonly onEditorMount?: (editor: TldrawEditor) => void;
  readonly onBoardChange?: (snapshot: CanvasSnapshot) => void;
  readonly onNormalizedBoardChange?: (change: NormalizedStudentShapeChange) => void;
  readonly className?: string;
  readonly style?: React.CSSProperties;
  readonly readOnly?: boolean;
  readonly colorScheme?: "light" | "dark";
}

export interface WhiteboardCanvasMountHandle {
  readonly mount: (container: HTMLElement) => void;
  readonly unmount: () => void;
  readonly getEditor: () => TldrawEditor | null;
  readonly getAdapter: () => TldrawWhiteboardAdapter | null;
}

/**
 * Imperative mount retained for narrow integrations and lifecycle tests.
 * The rendered surface is the same real tldraw component used by the app.
 */
export function createWhiteboardCanvasMount(props: WhiteboardCanvasProps): WhiteboardCanvasMountHandle {
  let root: Root | null = null;
  let editor: TldrawEditor | null = props.adapter?.getEditor() ?? null;

  return {
    mount(container: HTMLElement): void {
      root?.unmount();
      editor = null;
      root = createRoot(container);
      root.render(
        <WhiteboardCanvas
          {...props}
          onEditorMount={(mountedEditor) => {
            editor = mountedEditor;
            props.onEditorMount?.(mountedEditor);
          }}
        />
      );
    },

    unmount(): void {
      root?.unmount();
      root = null;
      editor = null;
    },

    getEditor(): TldrawEditor | null {
      return editor;
    },

    getAdapter(): TldrawWhiteboardAdapter | null {
      return props.adapter ?? null;
    }
  };
}

export const WhiteboardCanvas: React.FC<WhiteboardCanvasProps> = ({
  adapter,
  onEditorMount,
  onBoardChange,
  onNormalizedBoardChange,
  className = "whiteboard-canvas-container w-full h-full min-h-[380px]",
  style,
  readOnly = false,
  colorScheme = "light"
}) => {
  const standaloneAdapter = useMemo(() => new TldrawWhiteboardAdapter(), []);
  const effectiveAdapter = adapter ?? standaloneAdapter;
  const cleanupRef = useRef<(() => void) | null>(null);

  const cleanupMountedEditor = useCallback((): void => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  const handleMount = useCallback((nativeEditor: Editor): void => {
    cleanupMountedEditor();

    const bridge = new RealTldrawEditorBridge(nativeEditor, {
      initialBoardRevision: effectiveAdapter.getBoardRevision(),
      assertStudentMutationCanAdvance: () => effectiveAdapter.assertStudentMutationCanAdvance()
    });
    let removeOwnershipGuards: (() => void) | undefined;
    let unlisten: (() => void) | undefined;
    let attached = false;

    const rollback = (): void => {
      unlisten?.();
      removeOwnershipGuards?.();
      if (attached && effectiveAdapter.getEditor() === bridge) {
        effectiveAdapter.detachEditor();
      }
      if (cleanupRef.current === rollback) {
        cleanupRef.current = null;
      }
    };

    try {
      removeOwnershipGuards = bridge.installOwnershipGuards();
      effectiveAdapter.attachEditor(bridge);
      attached = true;
      nativeEditor.updateInstanceState({ isReadonly: readOnly });

      unlisten = bridge.subscribeToNormalizedStudentChanges((change) => {
        effectiveAdapter.observeNormalizedStudentMutation(change.source);
        onNormalizedBoardChange?.(change);
        onBoardChange?.(effectiveAdapter.getCanvasSnapshot());
      });

      cleanupRef.current = rollback;
      onEditorMount?.(bridge);
      onBoardChange?.(effectiveAdapter.getCanvasSnapshot());
    } catch (error) {
      rollback();
      throw error;
    }
  }, [
    cleanupMountedEditor,
    effectiveAdapter,
    onBoardChange,
    onEditorMount,
    onNormalizedBoardChange,
    readOnly
  ]);

  useEffect(() => {
    return () => {
      cleanupMountedEditor();
    };
  }, [cleanupMountedEditor]);

  useEffect(() => {
    const mountedEditor = effectiveAdapter.getEditor();
    if (mountedEditor instanceof RealTldrawEditorBridge) {
      mountedEditor.getNativeEditor().updateInstanceState({ isReadonly: readOnly });
    }
  }, [effectiveAdapter, readOnly]);

  return (
    <div
      data-whiteboard-canvas="true"
      data-readonly={String(readOnly)}
      className={className}
      style={style}
    >
      <Tldraw
        assetUrls={TLDRAW_ASSET_URLS}
        colorScheme={colorScheme}
        initialState="draw"
        onMount={handleMount}
      />
    </div>
  );
};

