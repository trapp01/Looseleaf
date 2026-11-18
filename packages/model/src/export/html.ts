/**
 * One page as a self-contained HTML file: containers sit where they sit on
 * the canvas, strokes are inline SVG and blobs are data URIs. Printing
 * switches to a single column in reading order, with the ink after it.
 */
import type { JSONContent } from '../rich-text.js';
import { INDENT_STEP_PX, TAG_LABELS, bodyToText, safeHref, type TagName } from '../rich-text.js';
import { PAPER_SPACING, type Container, type PageSnapshot } from '../page.js';
import { appPageAddress } from '../page-address.js';
import type { PageForExport } from './bundle.js';
import { cardLinkText } from './markdown.js';

export function pageToHtml(page: PageForExport): string {
  const { snapshot } = page;
  const created = new Date(page.createdAt);
  const items = snapshot.containers.map((c) => renderContainer(c, page.blobs, page.pageTitles)).join('\n');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title || 'Untitled page')}</title>
<style>${STYLES}</style>
</head>
<body>
<article class="page">
<header>
<h1>${escapeHtml(page.title)}</h1>
<time datetime="${created.toISOString()}">${escapeHtml(formatDate(created))}</time>
</header>
<div class="canvas" style="${canvasStyle(snapshot)}">
${items}
${renderInk(snapshot)}
</div>
</article>
</body>
</html>
`;
}

function formatDate(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
}

const STYLES = `
body { margin: 0; font: 11pt/1.4 Calibri, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f1f1f; background: #fff; }
.page { padding: 24px; }
header h1 { margin: 0 0 4px; font-size: 20pt; font-weight: 400; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
header time { color: #666; font-size: 9pt; }
.canvas { position: relative; margin-top: 16px; }
.container { position: absolute; box-sizing: border-box; }
.container p, .container h1, .container h2, .container h3, .container h4, .container h5, .container h6 { margin: 0 0 4px; }
.container table { border-collapse: collapse; }
.container td, .container th { border: 1px solid #999; padding: 2px 6px; vertical-align: top; }
.container img { max-width: 100%; height: auto; }
blockquote { margin: 0 0 4px 16px; padding-left: 8px; border-left: 3px solid #bbb; color: #444; }
pre { margin: 0 0 4px; font: 10pt Consolas, Menlo, monospace; white-space: pre-wrap; background: #f4f4f4; }
.citation { color: #666; font-size: 9pt; font-style: italic; }
.tag { font-size: 8pt; border: 1px solid #999; border-radius: 3px; padding: 0 3px; margin-right: 4px; }
.missing { border: 1px dashed #999; color: #666; padding: 8px; font-size: 9pt; }
.file a { text-decoration: none; border: 1px solid #ccc; border-radius: 4px; padding: 4px 8px; display: inline-block; }
.ink { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; }
@media print {
  .page { padding: 0; }
  .canvas { position: static; width: auto !important; min-height: 0 !important; background: none !important; }
  .container { position: static !important; width: auto !important; max-width: 100%; margin-bottom: 12px; }
  .ink { position: static; display: block; max-width: 100%; height: auto; }
}
`;

function canvasStyle(snapshot: PageSnapshot): string {
  let width = 0;
  let height = 0;
  for (const c of snapshot.containers) {
    width = Math.max(width, c.x + c.width);
    height = Math.max(height, c.y + containerHeight(c));
  }
  for (const s of snapshot.strokes) {
    for (let i = 0; i + 1 < s.points.length; i += 2) {
      width = Math.max(width, s.points[i]! + s.width);
      height = Math.max(height, s.points[i + 1]! + s.width);
    }
  }
  const parts = [`width: ${Math.ceil(width)}px`, `min-height: ${Math.ceil(height)}px`];
  const { paperColor, paperStyle } = snapshot.meta;
  if (paperColor) parts.push(`background-color: ${cssValue(paperColor)}`);
  const spacing = PAPER_SPACING[paperStyle];
  if (spacing !== null) {
    const line = `#c9d7e8 1px, transparent 1px`;
    const ruled = `linear-gradient(to bottom, ${line})`;
    const grid = `${ruled}, linear-gradient(to right, ${line})`;
    parts.push(`background-image: ${paperStyle.startsWith('grid') ? grid : ruled}`);
    parts.push(`background-size: ${spacing}px ${spacing}px`);
  }
  return parts.join('; ');
}

/** Text heights are not stored; this guesses about 20px a line so the canvas is tall enough on screen. */
function containerHeight(c: Container): number {
  if (c.kind === 'image') return c.height;
  if (c.kind === 'file') return 40;
  return bodyToText(c.body).split('\n').length * 20 + 8;
}

function renderContainer(c: Container, blobs: PageForExport['blobs'], pageTitles: PageForExport['pageTitles']): string {
  const box = `left: ${c.x}px; top: ${c.y}px; width: ${c.width}px; z-index: ${c.z}`;
  if (c.kind === 'text') return `<div class="container text" style="${box}">${renderBody(c.body, blobs, pageTitles)}</div>`;
  const bytes = blobs.get(c.blob) ?? null;
  if (c.kind === 'image') {
    const inner = bytes
      ? `<img src="${dataUri(c.mime, bytes)}" alt="${escapeHtml(c.name)}" width="${c.width}" height="${c.height}">`
      : `<div class="missing">Missing picture: ${escapeHtml(c.name)}</div>`;
    return `<figure class="container image" style="${box}; margin: 0">${inner}</figure>`;
  }
  const inner = bytes
    ? `<a href="${dataUri(c.mime, bytes)}" download="${escapeHtml(c.name)}">${escapeHtml(c.name)}</a>`
    : `<div class="missing">Missing file: ${escapeHtml(c.name)}</div>`;
  return `<div class="container file" style="${box}">${inner}</div>`;
}

function renderInk(snapshot: PageSnapshot): string {
  if (snapshot.strokes.length === 0) return '';
  let maxX = 0;
  let maxY = 0;
  const paths = snapshot.strokes.map((s) => {
    const pts: string[] = [];
    for (let i = 0; i + 1 < s.points.length; i += 2) {
      maxX = Math.max(maxX, s.points[i]! + s.width);
      maxY = Math.max(maxY, s.points[i + 1]! + s.width);
      pts.push(`${s.points[i]},${s.points[i + 1]}`);
    }
    const opacity = s.tool === 'highlighter' ? 0.4 : s.tool === 'marker' ? 0.85 : 1;
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${escapeHtml(s.color)}" stroke-width="${s.width}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
  });
  const w = Math.ceil(maxX);
  const h = Math.ceil(maxY);
  return `<svg class="ink" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${paths.join('')}</svg>`;
}

/**
 * A text container body as HTML. Pictures become data URIs, or a placeholder
 * when the blob is missing. A card link is a link to the desktop app's page
 * address showing the page title from `pageTitles`.
 */
export function renderBody(body: JSONContent, blobs: PageForExport['blobs'], pageTitles?: PageForExport['pageTitles']): string {
  const render = (node: JSONContent): string => {
    const children = () => (node.content ?? []).map(render).join('');
    const a = node.attrs ?? {};
    switch (node.type) {
      case 'doc':
        return children();
      case 'paragraph':
      case 'heading': {
        const name = node.type === 'heading' ? `h${a.level ?? 1}` : 'p';
        const element = a.style === 'quote' ? 'blockquote' : a.style === 'code' ? 'pre' : name;
        const attrs = [
          styleAttr({
            'text-align': a.textAlign,
            'margin-left': a.indent > 0 ? `${Number(a.indent) * INDENT_STEP_PX}px` : null,
          }),
          a.style === 'citation' ? 'class="citation"' : '',
          a.tag ? `data-tag="${escapeHtml(String(a.tag))}"` : '',
        ].filter(Boolean);
        const inner = tagHtml(a.tag as TagName | null, Boolean(a.checked)) + children();
        return `<${element}${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner || '<br>'}</${element}>`;
      }
      case 'bulletList':
        return `<ul>${children()}</ul>`;
      case 'orderedList':
        return `<ol${a.start && a.start !== 1 ? ` start="${Number(a.start)}"` : ''}>${children()}</ol>`;
      case 'listItem':
        return `<li>${children()}</li>`;
      case 'table':
        return `<table>${children()}</table>`;
      case 'tableRow':
        return `<tr>${children()}</tr>`;
      case 'tableCell':
      case 'tableHeader': {
        const element = node.type === 'tableHeader' ? 'th' : 'td';
        const attrs = [
          a.colspan > 1 ? `colspan="${Number(a.colspan)}"` : '',
          a.rowspan > 1 ? `rowspan="${Number(a.rowspan)}"` : '',
          styleAttr({
            'background-color': a.background,
            width: Array.isArray(a.colwidth) && a.colwidth[0] ? `${a.colwidth[0]}px` : null,
          }),
        ].filter(Boolean);
        return `<${element}${attrs.length ? ' ' + attrs.join(' ') : ''}>${children()}</${element}>`;
      }
      case 'image': {
        const bytes = a.blob ? (blobs.get(a.blob) ?? null) : null;
        if (!bytes) return `<div class="missing">Missing picture${a.alt ? `: ${escapeHtml(a.alt)}` : ''}</div>`;
        const size = [a.width ? `width="${Number(a.width)}"` : '', a.height ? `height="${Number(a.height)}"` : '']
          .filter(Boolean)
          .join(' ');
        return `<img src="${dataUri(String(a.mime ?? 'application/octet-stream'), bytes)}" alt="${escapeHtml(a.alt ?? '')}"${size ? ' ' + size : ''}>`;
      }
      case 'hardBreak':
        return '<br>';
      case 'cardLink': {
        if (typeof a.pageId !== 'string') return '';
        return `<a class="card-link" href="${escapeHtml(appPageAddress(a.pageId))}">${escapeHtml(cardLinkText({ pageTitles }, a.pageId))}</a>`;
      }
      case 'text':
        return renderText(node);
      default:
        return children();
    }
  };
  return render(body);
}

function tagHtml(tag: TagName | null, checked: boolean): string {
  if (!tag || !TAG_LABELS[tag]) return '';
  if (tag === 'todo') return `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;
  return `<span class="tag">${TAG_LABELS[tag]}</span>`;
}

function renderText(node: JSONContent): string {
  let html = escapeHtml(node.text ?? '');
  for (const mark of node.marks ?? []) {
    const a = mark.attrs ?? {};
    switch (mark.type) {
      case 'bold':
        html = `<strong>${html}</strong>`;
        break;
      case 'italic':
        html = `<em>${html}</em>`;
        break;
      case 'underline':
        html = `<u>${html}</u>`;
        break;
      case 'strike':
        html = `<s>${html}</s>`;
        break;
      case 'subscript':
        html = `<sub>${html}</sub>`;
        break;
      case 'superscript':
        html = `<sup>${html}</sup>`;
        break;
      case 'highlight':
        html = `<mark${styleAttr({ 'background-color': a.color }, ' ')}>${html}</mark>`;
        break;
      case 'textStyle': {
        const style = styleAttr(
          {
            color: a.color,
            'font-family': a.fontFamily,
            'font-size': typeof a.fontSize === 'number' ? `${a.fontSize}pt` : null,
          },
          ' ',
        );
        if (style) html = `<span${style}>${html}</span>`;
        break;
      }
      case 'link': {
        const href = safeHref(String(a.href ?? ''));
        if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`;
        break;
      }
    }
  }
  return html;
}

function styleAttr(props: Record<string, unknown>, lead = ''): string {
  const parts = Object.entries(props)
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .map(([k, v]) => `${k}: ${cssValue(v as string)}`);
  return parts.length ? `${lead}style="${escapeHtml(parts.join('; '))}"` : '';
}

/** Strips characters that would end a CSS declaration or the attribute it sits in. */
function cssValue(value: string): string {
  return value.replace(/[;"<>{}]/g, '');
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dataUri(mime: string, bytes: Uint8Array): string {
  return `data:${escapeHtml(mime)};base64,${toBase64(bytes)}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
