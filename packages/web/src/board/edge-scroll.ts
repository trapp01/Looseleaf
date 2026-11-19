/**
 * Scrolls the board sideways while a card or an Inbox line is dragged near
 * its left or right edge, faster the nearer the pointer is, for as long as it
 * stays there. The left edge is the pinned Inbox's right side, since the
 * statuses scroll under the Inbox, or the board's own edge when the Inbox is
 * empty and not shown.
 */
import { useEffect, type RefObject } from 'react';

/** How far in from an edge the scrolling starts, and the most it moves per frame, in px. */
const EDGE_ZONE = 72;
const MAX_STEP = 18;

/** How far to scroll this frame: negative to the left, positive to the right, 0 outside both zones. */
export function edgeScrollStep(pointerX: number, left: number, right: number): number {
  if (pointerX < left + EDGE_ZONE) return -Math.ceil((MAX_STEP * Math.min(EDGE_ZONE, left + EDGE_ZONE - pointerX)) / EDGE_ZONE);
  if (pointerX > right - EDGE_ZONE) return Math.ceil((MAX_STEP * Math.min(EDGE_ZONE, pointerX - (right - EDGE_ZONE))) / EDGE_ZONE);
  return 0;
}

export function useEdgeScroll(board: RefObject<HTMLElement>, dragging: boolean): void {
  useEffect(() => {
    if (!dragging) return;
    let pointerX: number | null = null;
    const onMove = (event: PointerEvent | TouchEvent) => {
      pointerX = 'touches' in event ? (event.touches[0]?.clientX ?? pointerX) : event.clientX;
    };
    let frame = requestAnimationFrame(function tick() {
      const el = board.current;
      if (el && pointerX !== null) {
        const rect = el.getBoundingClientRect();
        const dock = el.querySelector('.inbox-dock');
        // On a phone the dock scrolls with the statuses, so only a pinned dock moves the left edge.
        const pinned = dock && getComputedStyle(dock).position === 'sticky';
        const left = pinned ? dock.getBoundingClientRect().right : rect.left;
        const step = edgeScrollStep(pointerX, left, rect.right);
        if (step !== 0) el.scrollLeft += step;
      }
      frame = requestAnimationFrame(tick);
    });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('touchmove', onMove);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('touchmove', onMove);
    };
  }, [board, dragging]);
}
