/**
 * The freeform area of a page. Clicking empty canvas in text mode starts a
 * text container there; files dropped on it become pictures or file
 * containers at the drop point. It sizes itself to its content plus room to
 * grow, scales with the zoom, and lays the ink layer over the containers.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type * as Y from 'yjs';
import { addTextContainer } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { useStore } from '../app/store.js';
import { patchUi } from '../app/ui-state.js';
import { useYValue } from '../app/yjs-hooks.js';
import { ContainerView } from './ContainerView.js';
import { InkLayer } from './InkLayer.js';
import { placeFiles } from './insert.js';
import type { PageSession } from './page-session.js';

/** Height of the page title, hairline and created date above the canvas, in canvas px. */
export const TITLE_BLOCK_HEIGHT = 96;
const GROW_ROOM_X = 320;
const GROW_ROOM_Y = 480;
const NEW_CONTAINER_WIDTH = 400;
const MIN_FIT_WIDTH = 600;

export function Canvas({
  session,
  scroller,
  zoom,
  titleBlock,
}: {
  session: PageSession;
  scroller: RefObject<HTMLDivElement>;
  zoom: number;
  titleBlock: ReactNode;
}) {
  const services = useServices();
  const { ui } = services;
  const state = useStore(ui);
  const containers = session.doc.getMap<Y.Map<unknown>>('containers');
  const ids = useYValue(containers, () => [...containers.keys()].sort(), containers, true);
  const layer = useRef<HTMLDivElement>(null);
  const [extent, setExtent] = useState({ right: 0, bottom: 0 });
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const [autoFocus, setAutoFocus] = useState<{ id: string; entry: unknown } | null>(null);

  const measure = useCallback(() => {
    const el = layer.current;
    if (!el) return;
    let right = 0;
    let bottom = 0;
    for (const child of el.children as HTMLCollectionOf<HTMLElement>) {
      right = Math.max(right, child.offsetLeft + child.offsetWidth);
      bottom = Math.max(bottom, child.offsetTop + child.offsetHeight);
    }
    setExtent((prev) => (prev.right === right && prev.bottom === bottom ? prev : { right, bottom }));
  }, []);

  useEffect(() => {
    session.contentBottom = () => {
      measure();
      let bottom = 0;
      for (const child of (layer.current?.children ?? []) as HTMLCollectionOf<HTMLElement>) bottom = Math.max(bottom, child.offsetTop + child.offsetHeight);
      return bottom;
    };
  }, [session, measure]);

  useLayoutEffect(() => {
    measure();
    const el = layer.current;
    const view = scroller.current;
    if (!el || !view) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        measure();
        setViewport({ width: view.clientWidth, height: view.clientHeight });
      });
    });
    observer.observe(view);
    const watchChildren = () => {
      for (const child of el.children) observer.observe(child);
    };
    watchChildren();
    const mutations = new MutationObserver(() => {
      watchChildren();
      measure();
    });
    mutations.observe(el, { childList: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [measure, scroller]);

  // "Page width" fits the content's width into the window.
  const fitRequest = useRef(state.fitWidth);
  useEffect(() => {
    if (state.fitWidth === fitRequest.current) return;
    fitRequest.current = state.fitWidth;
    const width = Math.max(MIN_FIT_WIDTH, extent.right + 48);
    patchUi(ui, { zoom: Math.max(0.25, Math.min(3, (viewport.width - 32) / width)) });
  }, [state.fitWidth, extent.right, viewport.width, ui]);

  const width = Math.max(viewport.width / zoom, extent.right + GROW_ROOM_X);
  const height = Math.max((viewport.height / zoom) - TITLE_BLOCK_HEIGHT, extent.bottom + GROW_ROOM_Y);

  const pointToCanvas = (clientX: number, clientY: number) => {
    const rect = layer.current!.getBoundingClientRect();
    return { x: Math.max(0, (clientX - rect.left) / zoom), y: Math.max(0, (clientY - rect.top) / zoom) };
  };

  const drawing = state.tool !== 'text';

  return (
    <div className="page-sizer" style={{ width: width * zoom, height: (height + TITLE_BLOCK_HEIGHT) * zoom }}>
      <div className="page-zoom" style={{ width, transform: `scale(${zoom})` }}>
        {titleBlock}
        <div
          className={`canvas ${drawing ? 'is-drawing' : ''}`}
          style={{ height }}
          data-testid="canvas"
          onClick={(event) => {
            if (drawing || event.target !== event.currentTarget) return;
            const { x, y } = pointToCanvas(event.clientX, event.clientY);
            const maxWidth = Math.max(160, viewport.width / zoom - x - 16);
            const id = session.step(() => addTextContainer(session.doc, { x, y: Math.max(0, y - 12), width: Math.min(NEW_CONTAINER_WIDTH, maxWidth) }));
            setAutoFocus({ id, entry: session.lastEntry() });
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault();
          }}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files];
            if (files.length === 0) return;
            event.preventDefault();
            void placeFiles(services, session, files, { point: pointToCanvas(event.clientX, event.clientY) });
          }}
        >
          <div className="container-layer" ref={layer}>
            {ids.map((id) => {
              const map = containers.get(id);
              return map ? (
                <ContainerView
                  key={id}
                  id={id}
                  map={map}
                  session={session}
                  scroller={scroller}
                  zoom={zoom}
                  created={autoFocus?.id === id ? autoFocus : undefined}
                  onCreatedFocused={() => setAutoFocus(null)}
                />
              ) : null;
            })}
          </div>
          <InkLayer session={session} zoom={zoom} width={width} height={height} />
        </div>
      </div>
    </div>
  );
}
