export * from "./shape-model.js";
export * from "./dirty-region-coalescer.js";
export * from "./whiteboard-session.js";

import { BoardActionSchema, type BoardAction, type WhiteboardAdapter } from "../../domain/src/index.js";

export class InMemoryAiOverlay implements WhiteboardAdapter {
  public readonly actions: BoardAction[] = [];

  public async applyAiOverlayAction(action: BoardAction): Promise<void> {
    this.actions.push(BoardActionSchema.parse(action));
  }

  public async clearAiOverlay(): Promise<void> {
    this.actions.splice(0, this.actions.length);
  }
}
