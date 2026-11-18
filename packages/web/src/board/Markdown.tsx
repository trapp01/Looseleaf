/** Markdown rendered and sanitized; see render-markdown.ts. */
import { useMemo } from 'react';
import { renderMarkdown } from './render-markdown.js';

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
