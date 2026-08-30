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
  readonly style?: Record<string, string | number>;
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

export const WhiteboardCanvas = (props: WhiteboardCanvasProps): unknown => {
  return {
    type: "div",
    props: {
      "data-whiteboard-canvas": "true",
      "data-readonly": props.readOnly ?? false,
      className: props.className ?? "whiteboard-canvas-container",
      style: props.style
    }
  };
};
