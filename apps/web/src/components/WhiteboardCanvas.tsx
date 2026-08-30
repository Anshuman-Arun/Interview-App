import React, { useEffect, useRef } from "react";
import type {
  CanvasSnapshot,
  TldrawEditor,
  TldrawWhiteboardAdapter
} from "../tldraw-whiteboard-adapter.js";

export interface WhiteboardCanvasProps {
  readonly adapter?: TldrawWhiteboardAdapter;
  readonly onEditorMount?: (editor: TldrawEditor) => void;
  readonly onBoardChange?: (snapshot: CanvasSnapshot) => void;
  readonly className?: string;
  readonly style?: React.CSSProperties;
  readonly readOnly?: boolean;
}

export interface WhiteboardCanvasMountHandle {
  readonly mount: (container: HTMLElement) => void;
  readonly unmount: () => void;
  readonly getEditor: () => TldrawEditor | null;
  readonly getAdapter: () => TldrawWhiteboardAdapter | null;
}

export function createWhiteboardCanvasMount(props: WhiteboardCanvasProps): WhiteboardCanvasMountHandle {
  let editor: TldrawEditor | null = null;
  let unlisten: (() => void) | null = null;

  return {
    mount(container: HTMLElement): void {
      if (props.adapter !== undefined) {
        editor = props.adapter.getEditor();
      }

      if (editor !== null) {
        props.onEditorMount?.(editor);

        if (props.onBoardChange !== undefined && props.adapter !== undefined) {
          const adapter = props.adapter;
          const onBoardChange = props.onBoardChange;
          if (editor.store?.listen !== undefined) {
            unlisten = editor.store.listen(() => {
              onBoardChange(adapter.getCanvasSnapshot());
            });
          }
        }
      }

      container.setAttribute("data-whiteboard-canvas", "true");
      container.setAttribute("data-readonly", String(props.readOnly ?? false));
      if (props.className !== undefined) {
        container.className = props.className;
      }
    },

    unmount(): void {
      if (unlisten !== null) {
        unlisten();
        unlisten = null;
      }
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
  className = "whiteboard-canvas-container w-full h-full min-h-[380px]",
  style,
  readOnly = false
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (adapter === undefined) return;
    const editor = adapter.getEditor();
    if (editor !== null) {
      onEditorMount?.(editor);
      if (onBoardChange !== undefined && editor.store?.listen !== undefined) {
        const unlisten = editor.store.listen(() => {
          onBoardChange(adapter.getCanvasSnapshot());
        });
        return () => {
          unlisten();
        };
      }
    }
    return undefined;
  }, [adapter, onEditorMount, onBoardChange]);

  return (
    <div
      ref={containerRef}
      data-whiteboard-canvas="true"
      data-readonly={String(readOnly)}
      className={className}
      style={style}
    />
  );
};
