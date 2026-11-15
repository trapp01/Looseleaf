/**
 * Strokes on a page, drawn with perfect-freehand into an SVG laid over the
 * containers. In a drawing tool the layer takes the pointer: pen, marker and
 * highlighter add one stroke per press, the eraser removes whole strokes it
 * touches. In text mode it lets every press through to the containers.
 */
import { memo, useMemo, useRef, useState } from 'react';
import { getStroke } from 'perfect-freehand';
import { addStroke, deleteStroke, type Stroke, type StrokeTool } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { useYValue } from '../app/yjs-hooks.js';
import type { PageSession } from './page-session.js';

/** How much wider than the chosen width each tool draws. */
export const TOOL_SCALE: Record<StrokeTool, number> = { pen: 1, marker: 2.5, highlighter: 6 };

export function strokePath(stroke: Pick<Stroke, 'tool' | 'width' | 'points'>): string {
  const pairs: number[][] = [];
  for (let i = 0; i + 1 < stroke.points.length; i += 2) pairs.push([stroke.points[i]!, stroke.points[i + 1]!]);
  const outline = getStroke(pairs, {
    size: stroke.width,
    thinning: stroke.tool === 'pen' ? 0.5 : 0,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: stroke.tool === 'pen',
  });
  if (outline.length === 0) return '';
  const [first, ...rest] = outline;
  return `M${first![0]!.toFixed(1)} ${first![1]!.toFixed(1)}` + rest.map(([x, y]) => `L${x!.toFixed(1)} ${y!.toFixed(1)}`).join('') + 'Z';
}

export function InkLayer({ session, zoom, width, height }: { session: PageSession; zoom: number; width: number; height: number }) {
  const { ui } = useServices();
  const { tool, inkColor, inkWidth } = useStore(ui);
  const strokesMap = session.doc.getMap<Stroke>('strokes');
  const strokes = useYValue(strokesMap, () => [...strokesMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)), strokesMap, true);
  const svg = useRef<SVGSVGElement>(null);
  const [live, setLive] = useState<number[] | null>(null);
  const drawing = tool !== 'text';

  const point = (event: React.PointerEvent) => {
    const rect = svg.current!.getBoundingClientRect();
    return [(event.clientX - rect.left) / zoom, (event.clientY - rect.top) / zoom] as const;
  };
  const erase = (event: React.PointerEvent) => {
    for (const el of document.elementsFromPoint(event.clientX, event.clientY)) {
      const id = (el as SVGElement).dataset?.strokeId;
      if (id) deleteStroke(session.doc, id);
    }
  };

  return (
    <svg
      ref={svg}
      className={`ink-layer ${drawing ? 'is-active' : ''} tool-${tool}`}
      width={width}
      height={height}
      data-testid="ink-layer"
      onPointerDown={(event) => {
        if (!drawing || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        if (tool === 'eraser') return erase(event);
        setLive([...point(event)]);
      }}
      onPointerMove={(event) => {
        if (!drawing || !(event.buttons & 1)) return;
        if (tool === 'eraser') return erase(event);
        if (live) setLive([...live, ...point(event)]);
      }}
      onPointerUp={() => {
        if (live && tool !== 'eraser' && tool !== 'text') {
          const points = live.length === 2 ? [...live, live[0]! + 0.5, live[1]! + 0.5] : live;
          session.step(() => addStroke(session.doc, { tool, color: inkColor, width: inkWidth * TOOL_SCALE[tool], points }));
        }
        setLive(null);
      }}
    >
      {strokes.map(([id, stroke]) => (
        <StrokePath key={id} id={id} stroke={stroke} />
      ))}
      {live && tool !== 'eraser' && tool !== 'text' && (
        <path
          d={strokePath({ tool, width: inkWidth * TOOL_SCALE[tool], points: live })}
          fill={inkColor}
          className={`stroke tool-${tool}`}
        />
      )}
    </svg>
  );
}

const StrokePath = memo(function StrokePath({ id, stroke }: { id: string; stroke: Stroke }) {
  const d = useMemo(() => strokePath(stroke), [stroke]);
  return <path d={d} fill={stroke.color} data-stroke-id={id} className={`stroke tool-${stroke.tool}`} />;
});
