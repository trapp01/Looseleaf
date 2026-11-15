/**
 * One container on the canvas, in a frame that shows on hover or focus: a
 * drag bar on top to move it and a handle to resize it (width for text and
 * files, both sides keeping the aspect ratio for pictures). Moves and
 * resizes are single model writes, so undo takes them back in one step.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type * as Y from 'yjs';
import { ArrowDownloadRegular, DocumentRegular, ImageOffRegular } from '@fluentui/react-icons';
import { deleteContainer, moveContainer, resizeContainer, restackContainer } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { useYValue } from '../app/yjs-hooks.js';
import { showMenu } from '../nav/context-menu.js';
import { shell } from '../shell-bridge.js';
import { useBlobUrl } from './blob-urls.js';
import { formatBytes } from './files.js';
import type { PageSession } from './page-session.js';
import { TextBody } from './TextBody.js';

const MIN_WIDTH = 80;

interface Box {
  kind: 'text' | 'image' | 'file';
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  blob: string;
  mime: string;
  name: string;
  size: number;
}

function readBox(map: Y.Map<unknown>): Box {
  const kind = map.get('kind');
  return {
    kind: kind === 'image' || kind === 'file' ? kind : 'text',
    x: Number(map.get('x') ?? 0),
    y: Number(map.get('y') ?? 0),
    width: Number(map.get('width') ?? 0),
    height: Number(map.get('height') ?? 0),
    z: Number(map.get('z') ?? 0),
    blob: String(map.get('blob') ?? ''),
    mime: String(map.get('mime') ?? ''),
    name: String(map.get('name') ?? ''),
    size: Number(map.get('size') ?? 0),
  };
}

export function ContainerView({
  id,
  map,
  session,
  scroller,
  zoom,
  created,
  onCreatedFocused,
}: {
  id: string;
  map: Y.Map<unknown>;
  session: PageSession;
  scroller: RefObject<HTMLDivElement>;
  zoom: number;
  created?: { entry: unknown };
  onCreatedFocused: () => void;
}) {
  // The container's own fields only; text edits inside it do not re-render the frame.
  const box = useYValue(map, () => readBox(map), map, true);
  const [drag, setDrag] = useState<{ dx: number; dy: number; dw: number } | null>(null);
  const start = useRef<{ x: number; y: number; mode: 'move' | 'resize' } | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  const begin = (mode: 'move' | 'resize') => (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, y: event.clientY, mode };
    setDrag({ dx: 0, dy: 0, dw: 0 });
  };
  const moveTo = (event: ReactPointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = (event.clientX - s.x) / zoom;
    const dy = (event.clientY - s.y) / zoom;
    setDrag(s.mode === 'move' ? { dx, dy, dw: 0 } : { dx: 0, dy: 0, dw: dx });
  };
  const end = () => {
    const s = start.current;
    start.current = null;
    if (!s || !drag) return setDrag(null);
    if (s.mode === 'move' && (drag.dx !== 0 || drag.dy !== 0)) {
      session.step(() => moveContainer(session.doc, id, { x: Math.max(0, box.x + drag.dx), y: Math.max(0, box.y + drag.dy) }));
    } else if (s.mode === 'resize' && drag.dw !== 0) {
      const width = Math.max(MIN_WIDTH, box.width + drag.dw);
      session.step(() =>
        box.kind === 'image' && box.width > 0
          ? resizeContainer(session.doc, id, { width, height: Math.round((width * box.height) / box.width) })
          : resizeContainer(session.doc, id, { width }),
      );
    }
    setDrag(null);
  };

  const openMenu = (x: number, y: number) =>
    showMenu(x, y, [
      { label: 'Bring to front', onSelect: () => session.step(() => restackContainer(session.doc, id, 'front')) },
      { label: 'Send to back', onSelect: () => session.step(() => restackContainer(session.doc, id, 'back')) },
      'separator',
      { label: 'Delete', danger: true, onSelect: () => session.step(() => deleteContainer(session.doc, id)) },
    ]);

  const width = Math.max(MIN_WIDTH, box.width + (drag?.dw ?? 0));
  const height = box.kind === 'image' && box.width > 0 ? (width * box.height) / box.width : undefined;

  return (
    <div
      ref={frame}
      className={`container kind-${box.kind} ${drag ? 'is-dragging' : ''}`}
      data-container-id={id}
      data-testid={`container-${box.kind}`}
      style={{
        left: box.x,
        top: box.y,
        width,
        zIndex: box.z + 1,
        transform: drag && (drag.dx || drag.dy) ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
      }}
      tabIndex={box.kind === 'text' ? undefined : 0}
      onKeyDown={(event) => {
        if (box.kind !== 'text' && (event.key === 'Delete' || event.key === 'Backspace') && event.target === frame.current) {
          event.preventDefault();
          session.step(() => deleteContainer(session.doc, id));
        }
      }}
    >
      <div
        className="container-bar"
        aria-label="Move"
        title="Drag to move"
        data-testid="container-bar"
        onPointerDown={begin('move')}
        onPointerMove={moveTo}
        onPointerUp={end}
        onPointerCancel={end}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(event.clientX, event.clientY);
        }}
        onDoubleClick={() => frame.current?.focus()}
      />
      {box.kind === 'text' ? (
        <TextBody id={id} map={map} session={session} scroller={scroller} created={created} onCreatedFocused={onCreatedFocused} />
      ) : box.kind === 'image' ? (
        <ImageBody hash={box.blob} mime={box.mime} name={box.name} height={height ?? box.height} />
      ) : (
        <FileBody hash={box.blob} mime={box.mime} name={box.name} size={box.size} />
      )}
      <div
        className={`container-resize ${box.kind === 'image' ? 'is-corner' : ''}`}
        aria-label="Resize"
        onPointerDown={begin('resize')}
        onPointerMove={moveTo}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  );
}

function ImageBody({ hash, mime, name, height }: { hash: string; mime: string; name: string; height: number }) {
  const { blobs } = useServices();
  const state = useBlobUrl(blobs, hash || null, mime);
  if (state.status === 'ready') return <img className="container-image" src={state.url} alt={name} style={{ height }} draggable={false} />;
  return (
    <div className="blob-placeholder" style={{ height }} data-state={state.status}>
      {state.status === 'missing' && (
        <>
          <ImageOffRegular />
          <span>Picture not on this device yet</span>
        </>
      )}
    </div>
  );
}

function FileBody({ hash, mime, name, size }: { hash: string; mime: string; name: string; size: number }) {
  const { blobs, client } = useServices();
  const state = useBlobUrl(blobs, hash || null, mime);
  const open = async () => {
    const bridge = shell();
    if (bridge) {
      const bytes = await client.getBlob(hash);
      if (bytes) await bridge.saveFile(name, bytes);
      return;
    }
    if (state.status !== 'ready') return;
    const link = document.createElement('a');
    link.href = state.url;
    link.download = name;
    link.click();
  };
  return (
    <div className="file-card">
      <DocumentRegular className="file-icon" />
      <div className="file-text">
        <span className="file-name">{name || 'File'}</span>
        <span className="file-size">{state.status === 'missing' ? 'Not on this device yet' : formatBytes(size)}</span>
      </div>
      <button className="icon-button" aria-label={`Download ${name}`} title="Download" disabled={state.status !== 'ready'} onClick={open}>
        <ArrowDownloadRegular />
      </button>
    </div>
  );
}
