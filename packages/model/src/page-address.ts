/**
 * A page address: what another program opens to land on one page. In a
 * browser it is the web client's URL ending in `#page=<pageId>`; the desktop
 * app answers `looseleaf://page/<pageId>`. Both carry only the page id, so an
 * address stays good when the page is renamed or moved.
 */
const HASH_PREFIX = '#page=';
const PAGE_ID = /^[A-Za-z0-9_-]+$/;

/** The URL scheme the desktop app registers with the operating system. */
export const APP_ADDRESS_SCHEME = 'looseleaf';
const APP_PREFIX = `${APP_ADDRESS_SCHEME}://page/`;

/** The fragment that makes the web client open a page, `#` included. */
export function pageHash(pageId: string): string {
  return `${HASH_PREFIX}${pageId}`;
}

/** The page id in a URL fragment (`location.hash`), or null when the fragment is not a page address. */
export function pageIdFromHash(hash: string): string | null {
  return hash.startsWith(HASH_PREFIX) ? validPageId(hash.slice(HASH_PREFIX.length)) : null;
}

/** The address the desktop app opens a page at. */
export function appPageAddress(pageId: string): string {
  return `${APP_PREFIX}${pageId}`;
}

/** The page id in a `looseleaf://page/<pageId>` address, or null for anything else. */
export function pageIdFromAppAddress(address: string): string | null {
  if (!address.toLowerCase().startsWith(APP_PREFIX)) return null;
  return validPageId(address.slice(APP_PREFIX.length).replace(/\/$/, ''));
}

function validPageId(text: string): string | null {
  return PAGE_ID.test(text) ? text : null;
}
