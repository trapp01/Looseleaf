/**
 * The small icons tagged paragraphs show at their left. Editors and static
 * renders draw them in CSS (rich-text.css) as masks, so the icons are turned
 * into SVG data URLs once at start and set as custom properties on :root.
 */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { BookOpenFilled, FlagFilled, QuestionCircleFilled, StarFilled } from '@fluentui/react-icons';
import type { TagName } from '@looseleaf/model';

export const TAG_ICONS = {
  important: StarFilled,
  question: QuestionCircleFilled,
  remember: FlagFilled,
  definition: BookOpenFilled,
} satisfies Partial<Record<TagName, unknown>>;

export function installTagIcons(): void {
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <>
        {Object.entries(TAG_ICONS).map(([tag, Icon]) => (
          <Icon key={tag} data-tag={tag} />
        ))}
      </>,
    ),
  );
  for (const svg of host.querySelectorAll('svg')) {
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const url = `url("data:image/svg+xml,${encodeURIComponent(svg.outerHTML)}")`;
    document.documentElement.style.setProperty(`--tag-icon-${svg.getAttribute('data-tag')}`, url);
  }
  root.unmount();
}
