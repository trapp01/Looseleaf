/**
 * Adding pictures and files to the open page. Pictures go into the text at
 * the caret when an editor is given, else each becomes an image container;
 * other files always become file containers. Without a drop point they land
 * at the left margin under the page's content.
 */
import type { Editor } from '@tiptap/core';
import { addFileContainer, addImageContainer } from '@looseleaf/model';
import type { Services } from '../app/services.js';
import { imageSize } from './files.js';
import type { PageSession } from './page-session.js';

const MAX_PICTURE_WIDTH = 640;
const FILE_WIDTH = 280;
const MARGIN_X = 48;
const STAGGER = 24;

export async function placeFiles(
  services: Services,
  session: PageSession,
  files: File[],
  where: { editor?: Editor | null; point?: { x: number; y: number } },
): Promise<void> {
  let x = where.point?.x ?? MARGIN_X;
  let y = where.point?.y ?? session.contentBottom() + STAGGER;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const blob = await services.client.putBlob(bytes);
    const ref = { blob, mime: file.type || 'application/octet-stream', name: file.name, size: file.size };
    if (file.type.startsWith('image/')) {
      const natural = await imageSize(file);
      const scale = Math.min(1, MAX_PICTURE_WIDTH / natural.width);
      const width = Math.round(natural.width * scale);
      const height = Math.round(natural.height * scale);
      if (where.editor && !where.editor.isDestroyed) {
        where.editor.chain().focus().insertContent({ type: 'image', attrs: { blob, mime: ref.mime, width, height, alt: file.name } }).run();
        continue;
      }
      addImageContainer(session.doc, { x, y, width, height, ...ref });
      y += height + STAGGER;
    } else {
      addFileContainer(session.doc, { x, y, width: FILE_WIDTH, ...ref });
      y += 64 + STAGGER;
    }
    x += where.point ? STAGGER : 0;
  }
}
