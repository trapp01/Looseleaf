import type { PageLevel } from '../notebook.js';
import type { Container, PageMeta, Stroke } from '../page.js';
import type { PageForExport } from './bundle.js';

/**
 * The lossless JSON form of one page. Blobs are referenced by SHA-256 hex
 * (`blob` on image and file containers and on `image` nodes in text bodies);
 * a multi-page export stores their bytes as `blobs/<hash>`. Text bodies are
 * ProseMirror JSON in the rich-text schema with every attribute present.
 * Lengths are CSS px, font sizes pt, times epoch ms.
 */
export interface PageJson {
  format: 'looseleaf-page';
  version: 1;
  id: string;
  title: string;
  level: PageLevel;
  createdAt: number;
  modifiedAt: number;
  meta: PageMeta;
  /** In reading order. */
  containers: Container[];
  strokes: Array<Stroke & { id: string }>;
}

export function pageToJson(page: PageForExport): PageJson {
  return {
    format: 'looseleaf-page',
    version: 1,
    id: page.id,
    title: page.title,
    level: page.level,
    createdAt: page.createdAt,
    modifiedAt: page.modifiedAt,
    meta: page.snapshot.meta,
    containers: page.snapshot.containers,
    strokes: page.snapshot.strokes,
  };
}
