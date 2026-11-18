/**
 * A text container's content. Far from the viewport it is a static render of
 * the Y.XmlFragment (cheap, so pages with hundreds of containers open fast);
 * near the viewport, or once pressed, it becomes a TipTap editor bound to the
 * fragment. A pressed static render hands its click point to the editor so
 * the caret lands where the person pressed. Both draw pictures from the blob
 * URL cache and let only allowed link schemes through.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as Y from 'yjs';
import { EditorContent, useEditor } from '@tiptap/react';
import { DOMSerializer } from '@tiptap/pm/model';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { deleteContainer, richTextSchema } from '@looseleaf/model';
import { useServices } from '../app/services.js';
import { cardLinkSource, drawCardLink, type CardLinkSource } from '../board/card-link-view.js';
import { inboxPill, type InboxPills } from '../board/inbox-pill.js';
import { showLineMenu } from '../board/line-menu.js';
import type { BlobUrlCache } from './blob-urls.js';
import { placeFiles } from './insert.js';
import { stripUnsafeLinks } from './links.js';
import type { PageSession } from './page-session.js';
import { textEditorExtensions, type TextEditorEnv } from './text-editor.js';

/** Editors mount this far outside the visible area, so scrolling rarely shows a static render. */
const MOUNT_MARGIN = '800px 0px';

let serializer: DOMSerializer | null = null;

export function TextBody({
  id,
  map,
  session,
  scroller,
  created,
  onCreatedFocused,
}: {
  id: string;
  map: Y.Map<unknown>;
  session: PageSession;
  scroller: RefObject<HTMLDivElement>;
  created?: { entry: unknown };
  onCreatedFocused: () => void;
}) {
  const services = useServices();
  const { blobs } = services;
  const cardLinks = useMemo(() => cardLinkSource(services), [services]);
  const inbox = useMemo(() => inboxPills(services, session), [services, session]);
  const body = map.get('body');
  const fragment = body instanceof Y.XmlFragment ? body : null;
  const [live, setLive] = useState(!!created);
  const host = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const click = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setLive(true);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setLive(true);
        else if (!focused.current) setLive(false);
      },
      { root: scroller.current, rootMargin: MOUNT_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [scroller]);

  if (!fragment) return null;
  return (
    <div ref={host} className="text-body">
      {live ? (
        <LiveEditor
          id={id}
          fragment={fragment}
          session={session}
          created={created}
          click={click}
          onFocusChange={(f) => (focused.current = f)}
          onCreatedFocused={onCreatedFocused}
        />
      ) : (
        <StaticBody
          fragment={fragment}
          blobs={blobs}
          cardLinks={cardLinks}
          inbox={inbox}
          onPress={(x, y) => {
            click.current = { x, y };
            setLive(true);
          }}
        />
      )}
    </div>
  );
}

function LiveEditor({
  id,
  fragment,
  session,
  created,
  click,
  onFocusChange,
  onCreatedFocused,
}: {
  id: string;
  fragment: Y.XmlFragment;
  session: PageSession;
  created?: { entry: unknown };
  click: RefObject<{ x: number; y: number } | null>;
  onFocusChange: (focused: boolean) => void;
  onCreatedFocused: () => void;
}) {
  const services = useServices();
  const createdEntry = useRef(created);
  const focusOnMount = useRef(!!created);
  const env = useMemo<TextEditorEnv>(
    () => ({
      blobs: services.blobs,
      commands: services.commands,
      putBlob: (bytes) => services.client.putBlob(bytes),
      addFiles: (files) => void placeFiles(services, session, files, {}),
      cardLinks: cardLinkSource(services),
      inbox: inboxPills(services, session),
    }),
    [services, session],
  );
  const editor = useEditor(
    {
      extensions: textEditorExtensions(fragment, env),
      editorProps: { attributes: { class: 'rich-text', spellcheck: 'true' } },
      shouldRerenderOnTransaction: false,
      onFocus: ({ editor: e }) => {
        onFocusChange(true);
        services.activeEditor.set(e);
      },
      onBlur: ({ editor: e }) => {
        onFocusChange(false);
        // A container left empty is removed, unless focus only moved to the ribbon or a menu to format it.
        setTimeout(() => {
          // Switching to another window leaves the editor as the active element; that is not leaving the container.
          if (e.isDestroyed || e.isFocused || !e.isEmpty || document.activeElement === e.view.dom) return;
          if (document.activeElement?.closest('.ribbon, .popover, .format-bar, .dialog, .context-menu')) return;
          const entry = createdEntry.current;
          if (entry) session.runUntracked(() => deleteContainer(session.doc, id), entry.entry);
          else deleteContainer(session.doc, id);
        }, 0);
      },
    },
    [fragment, env],
  );

  useEffect(() => {
    if (!editor) return;
    const at = click.current;
    if (at) {
      (click as { current: { x: number; y: number } | null }).current = null;
      const pos = editor.view.posAtCoords({ left: at.x, top: at.y });
      editor.commands.focus(pos?.pos ?? 'end');
    } else if (focusOnMount.current) {
      focusOnMount.current = false;
      editor.commands.focus('end');
      onCreatedFocused();
    }
  }, [editor, click, onCreatedFocused]);

  return <EditorContent editor={editor} />;
}

/** The open page's Inbox lines and the line menu they open. */
function inboxPills(services: ReturnType<typeof useServices>, session: PageSession): InboxPills {
  return {
    lines: session.inbox,
    openMenu: (lineId, x, y) => {
      const current = services.boards.current.get();
      if (current) showLineMenu(services, current.board, { notebookId: session.notebookId, pageId: session.pageId, lineId }, x, y);
    },
  };
}

function StaticBody({
  fragment,
  blobs,
  cardLinks,
  inbox,
  onPress,
}: {
  fragment: Y.XmlFragment;
  blobs: BlobUrlCache;
  cardLinks: CardLinkSource;
  inbox: InboxPills;
  onPress: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let pictures: Array<{ img: HTMLImageElement; hash: string }> = [];
    let links: HTMLElement[] = [];
    const drawLinks = () => {
      for (const link of links) drawCardLink(link, cardLinks.read(link.dataset.cardLink ?? ''));
    };
    let lines: HTMLElement[] = [];
    const drawPills = () => {
      const ids = inbox.lines.get();
      for (const line of lines) {
        line.querySelector(':scope > .inbox-pill')?.remove();
        const lineId = line.dataset.lineId ?? '';
        if (ids.has(lineId)) line.append(inboxPill(lineId, inbox));
      }
    };
    const show = () => {
      for (const { img, hash } of pictures) {
        const state = blobs.state(hash);
        img.dataset.state = state.status;
        if (state.status === 'ready') img.src = state.url;
        else img.removeAttribute('src');
      }
    };
    const render = () => {
      const el = ref.current;
      if (!el) return;
      try {
        serializer ??= DOMSerializer.fromSchema(richTextSchema);
        const node = yXmlFragmentToProseMirrorRootNode(fragment, richTextSchema);
        const dom = serializer.serializeFragment(node.content) as DocumentFragment;
        const next: typeof pictures = [];
        for (const img of dom.querySelectorAll<HTMLImageElement>('img[data-blob]')) {
          const w = Number(img.dataset.width) || 0;
          const h = Number(img.dataset.height) || 0;
          if (w) img.style.width = `${w}px`;
          if (w && h) img.style.aspectRatio = `${w} / ${h}`;
          img.classList.add('static-picture');
          img.draggable = false;
          blobs.acquire(img.dataset.blob!, img.dataset.mime ?? 'image/png');
          next.push({ img, hash: img.dataset.blob! });
        }
        stripUnsafeLinks(dom);
        links = [...dom.querySelectorAll<HTMLElement>('span[data-card-link]')];
        drawLinks();
        lines = [...dom.querySelectorAll<HTMLElement>('[data-tag="todo"][data-line-id]')];
        drawPills();
        // Acquire the new pictures before releasing the old, so an unchanged picture keeps its URL.
        for (const p of pictures) blobs.release(p.hash);
        pictures = next;
        el.replaceChildren(dom);
        show();
      } catch (error) {
        console.warn('Could not draw a text container', error);
      }
    };
    render();
    const unsubscribe = blobs.subscribe(show);
    // Only bodies holding card links follow the board, so a page of plain notes never redraws for it.
    const stopLinks = cardLinks.subscribe(() => links.length > 0 && drawLinks());
    const stopPills = inbox.lines.subscribe(() => lines.length > 0 && drawPills());
    fragment.observeDeep(render);
    return () => {
      fragment.unobserveDeep(render);
      unsubscribe();
      stopLinks();
      stopPills();
      for (const p of pictures) blobs.release(p.hash);
    };
  }, [fragment, blobs, cardLinks, inbox]);
  return (
    <div
      ref={ref}
      className="rich-text is-static"
      onPointerDown={(event) => {
        if (event.button === 0) onPress(event.clientX, event.clientY);
      }}
    />
  );
}
