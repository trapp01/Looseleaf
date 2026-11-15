/**
 * The one check on link targets leaving a text container, for the editor's
 * Cmd/Ctrl-click and for the static render. Only http, https, mailto and tel
 * links go anywhere; any other scheme, or text that is not a full URL, does nothing.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** The link's URL when its scheme is allowed, otherwise null. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  try {
    const url = new URL(href);
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Opens an allowed link in a new tab or window; any other link is ignored. */
export function openLink(href: unknown): void {
  const url = safeHref(href);
  if (url) window.open(url, '_blank', 'noopener');
}

/** Keeps allowed hrefs inside `root` and strips every other one. */
export function stripUnsafeLinks(root: ParentNode): void {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const url = safeHref(a.getAttribute('href'));
    if (url) a.setAttribute('href', url);
    else a.removeAttribute('href');
  }
}
