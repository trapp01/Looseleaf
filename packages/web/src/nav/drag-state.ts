import type { DragPayload } from './drop.js';

// Browsers hide drag data until drop, so rows read what is being dragged from here while hovering.
let dragging: DragPayload | null = null;

export function currentDrag(): DragPayload | null {
  return dragging;
}

export function setCurrentDrag(payload: DragPayload | null): void {
  dragging = payload;
}
