/**
 * Where each notebook, section group, section and page goes as folders and
 * files, for the multi-file exports and the mirror. Both lay out a tree here,
 * so a zip export and a mirror name the same page the same way.
 */
import type { PageEntry, TreeChild } from '../notebook.js';
import { NameAllocator, sanitizeName } from './names.js';

/** A group or section folder, or a page file, in tree order (a folder comes before what it holds). */
export type LayoutItem =
  | { kind: 'folder'; path: string[] }
  | {
      kind: 'page';
      page: PageEntry;
      /** Folder segments from the root, each sanitized and unique among its siblings. */
      folder: string[];
      fileName: string;
      sectionId: string;
      /** The names of the groups above the section and the section itself, as typed, outermost first. */
      sectionNames: string[];
    };

/** A notebook's folder name, taken from the library-wide allocator. */
export function notebookFolderName(name: string, names: NameAllocator): string {
  return names.take(sanitizeName(name, 'Untitled notebook'));
}

/** A page's file name with `extension` (such as `.md`), taken from its section's allocator. */
export function pageFileName(title: string, names: NameAllocator, extension: string): string {
  return names.take(sanitizeName(title, 'Untitled page'), extension);
}

/**
 * Lays out groups and sections (and their pages) under `folder`. `names` is
 * the allocator for that folder; each group and section gets its own.
 */
export function layoutChildren(
  children: TreeChild[],
  folder: string[],
  names: NameAllocator,
  extension: string,
  parentNames: string[] = [],
): LayoutItem[] {
  const items: LayoutItem[] = [];
  for (const child of children) {
    const path = [...folder, names.take(sanitizeName(child.name, `Untitled ${child.kind === 'group' ? 'section group' : 'section'}`))];
    const sectionNames = [...parentNames, child.name];
    items.push({ kind: 'folder', path });
    if (child.kind === 'group') {
      items.push(...layoutChildren(child.children, path, new NameAllocator(), extension, sectionNames));
    } else {
      const pageNames = new NameAllocator();
      for (const page of child.pages) {
        const fileName = pageFileName(page.title, pageNames, extension);
        items.push({ kind: 'page', page, folder: path, fileName, sectionId: child.id, sectionNames });
      }
    }
  }
  return items;
}
