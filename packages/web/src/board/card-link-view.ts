/**
 * How a card link in a note looks and what clicking it does. It shows the
 * card's ref, its page title and its status, read from the current board and
 * notebook docs and redrawn as they change; a link to an archived card shows
 * "archived", and a link to a page that is not a card on the loaded board
 * shows the page title only. Clicking opens the page (see open-page.ts). The
 * editor draws it as a node view and the static render fills the same spans.
 */
import type { AnyExtension, Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type * as Y from 'yjs';
import { findCard, findStatus, formatCardRef, getNode, shownStatusId, type StatusKind } from '@looseleaf/model';
import type { Services } from '../app/services.js';
import type { CurrentBoard } from './live-board.js';
import { openPage } from './open-page.js';

export interface CardLinkInfo {
  title: string;
  /** Null when the page is not a card on the loaded board. */
  ref: string | null;
  /** The status name; null for an archived card and for a page that is not a card. */
  status: string | null;
  kind: StatusKind | null;
  archived: boolean;
}

/** Where card links read their card from, hear about changes, and open their page. */
export interface CardLinkSource {
  read(pageId: string): CardLinkInfo;
  /** Calls `listener` after anything a card link shows may have changed. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  open(pageId: string): void;
}

const NO_PAGE_TITLE = 'Linked card';

export function describeCardLink(current: CurrentBoard | null, notebooks: Iterable<Y.Doc>, pageId: string): CardLinkInfo {
  let pageTitle: string | null = null;
  for (const doc of current ? [current.notebookDoc, ...notebooks] : notebooks) {
    const node = getNode(doc, pageId);
    if (node?.kind === 'page') {
      pageTitle = node.name || 'Untitled page';
      break;
    }
  }
  const card = current ? findCard(current.board, pageId) : null;
  if (!current || !card) return { title: pageTitle ?? NO_PAGE_TITLE, ref: null, status: null, kind: null, archived: false };
  const archived = card.archivedAt !== null;
  const status = archived ? null : findStatus(current.board, shownStatusId(current.board, card) ?? card.statusId);
  return {
    title: card.title || pageTitle || 'Untitled page',
    ref: formatCardRef(current.board.meta.key, card.number),
    status: status?.name ?? null,
    kind: status?.kind ?? null,
    archived,
  };
}

export function cardLinkSource(services: Services): CardLinkSource {
  return {
    read: (pageId) => describeCardLink(services.boards.current.get(), services.notebooks.docs.get().values(), pageId),
    subscribe: (listener) => {
      const stopBoard = services.boards.current.subscribe(listener);
      const stopDocs = services.notebooks.docs.subscribe(listener);
      return () => {
        stopBoard();
        stopDocs();
      };
    },
    open: (pageId) => openPage(services, pageId),
  };
}

function part(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/** Fills a card link's element with its ref, title and status. */
export function drawCardLink(el: HTMLElement, info: CardLinkInfo): void {
  el.classList.add('card-link');
  el.dataset.state = info.archived ? 'archived' : info.ref ? 'card' : 'page';
  if (info.kind) el.dataset.kind = info.kind;
  else delete el.dataset.kind;
  const parts = [part('card-link-title', info.title)];
  if (info.ref) parts.unshift(part('card-link-ref', info.ref));
  if (info.archived) parts.push(part('card-link-status', 'archived'));
  else if (info.status) parts.push(part('card-link-status', info.status));
  el.replaceChildren(...parts);
  el.title = `Open ${info.title}`;
}

/** The model's `cardLink` node, drawn live from `source` and opening its page on click. */
export function cardLinkWithView(ext: AnyExtension, source: CardLinkSource): AnyExtension {
  return (ext as ReturnType<typeof Extension.create>).extend({
    addNodeView() {
      return ({ node }: { node: PMNode }) => {
        const dom = document.createElement('span');
        dom.contentEditable = 'false';
        dom.setAttribute('role', 'link');
        let current = node;
        const pageId = () => String(current.attrs.pageId ?? '');
        const draw = () => {
          dom.dataset.cardLink = pageId();
          drawCardLink(dom, source.read(pageId()));
        };
        draw();
        const unsubscribe = source.subscribe(draw);
        dom.addEventListener('click', (event) => {
          if (event.button !== 0 || event.shiftKey) return;
          event.preventDefault();
          source.open(pageId());
        });
        return {
          dom,
          update: (next: PMNode) => {
            if (next.type !== current.type) return false;
            current = next;
            draw();
            return true;
          },
          ignoreMutation: () => true,
          destroy: unsubscribe,
        };
      };
    },
  });
}
