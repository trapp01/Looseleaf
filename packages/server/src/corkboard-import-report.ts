/**
 * What a Corkboard import prints and saves as JSON: where the board came from
 * and went, the page each ref now has, what the owner should look at (titles
 * replaced, pages several cards link to, links not adopted, descriptions already on their page, blobs
 * Corkboard did not hold) and the counts of the source beside the result.
 */
import type { ImportCheck } from './corkboard-import-check.js';
import type { LinkNotAdopted, SharedPage } from './corkboard-import.js';

export interface ImportReport {
  dryRun: boolean;
  /** Epoch ms the import used as the board's created time. */
  importedAt: number;
  source: { folder: string; boardId: string; boardKey: string; boardName: string };
  target: { folder: string; notebookId: string; notebookName: string };
  cards: Array<{ ref: string; pageId: string; page: 'adopted' | 'new'; title: string; sectionId: string }>;
  titlesReplaced: Array<{ ref: string; pageId: string; oldTitle: string; newTitle: string }>;
  linksNotAdopted: LinkNotAdopted[];
  /** Live pages several cards link to; each of those cards has a new page and keeps its link. */
  sharedPages: SharedPage[];
  descriptionsAlreadyOnPage: string[];
  /** What a description's Markdown could not keep, per ref. */
  descriptionWarnings: Array<{ ref: string; warning: string }>;
  /** Attachments added to their page whose blob could not be copied. */
  blobProblems: Array<{ ref: string; name: string; blob: string; problem: string }>;
  statusCounts: ImportCheck['statusCounts'];
  totals: ImportCheck['totals'];
  /** `memory` for a dry run; `disk` when the result was read back from the data folder. */
  checkedFrom: 'memory' | 'disk';
  mismatches: string[];
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => `  ${row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join('  ')}`.trimEnd());
}

/** The report as the command prints it. */
export function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  const { source, target } = report;
  lines.push(report.dryRun ? 'Corkboard import, dry run: nothing was written.' : 'Corkboard import.');
  lines.push(`From board ${source.boardKey} "${source.boardName}" in ${source.folder}`);
  lines.push(`Into notebook "${target.notebookName}" (${target.notebookId}) in ${target.folder}`);
  lines.push('');

  lines.push('Cards per status');
  lines.push(
    ...table([
      ['status', 'source', 'result', 'archived in source', 'archived in result'],
      ...report.statusCounts.map((count) => [
        `${count.name} (${count.kind}${count.archived ? ', archived' : ''})`,
        String(count.source),
        String(count.result),
        String(count.archivedCardsSource),
        String(count.archivedCardsResult),
      ]),
    ]),
  );
  lines.push('');

  const adopted = report.cards.filter((card) => card.page === 'adopted').length;
  lines.push(`Cards (${report.cards.length}: ${adopted} on pages they linked to, ${report.cards.length - adopted} on new pages)`);
  for (const card of report.cards) lines.push(`  ${card.ref}  ${card.pageId}  ${card.page === 'adopted' ? 'adopted' : 'new    '}  ${card.title}`);
  lines.push('');

  const section = (title: string, items: string[]) => {
    lines.push(`${title} (${items.length})`);
    lines.push(...(items.length === 0 ? ['  none'] : items.map((item) => `  ${item}`)));
    lines.push('');
  };
  section(
    'Titles that replaced a different page title; the old one is written on the page',
    report.titlesReplaced.map((item) => `${item.ref}  ${item.pageId}  "${item.oldTitle}" became "${item.newTitle}"`),
  );
  section(
    'Pages several cards link to; none of them took the page, each has a new page and keeps its link',
    report.sharedPages.map((page) => `${page.pageId}  "${page.title}": ${page.refs.join(', ')}`),
  );
  section('Links not adopted as the card\'s page; each stays a link on the card', report.linksNotAdopted.map((link) => `${link.ref}  ${link.target}: ${link.reason}`));
  section('Descriptions the page already held, so not added again', report.descriptionsAlreadyOnPage);
  section('Description Markdown that could not be kept as written', report.descriptionWarnings.map((item) => `${item.ref}: ${item.warning}`));
  section('Attachments whose blob Corkboard does not hold intact; added to the page without it', report.blobProblems.map((item) => `${item.ref}  "${item.name}" (${item.blob}): ${item.problem}`));

  const { totals } = report;
  lines.push('Totals');
  lines.push(
    ...table([
      ['', 'source', 'result'],
      ['cards', String(totals.cards.source), String(totals.cards.result)],
      ['comments', String(totals.comments.source), String(totals.comments.result)],
      ['links', String(totals.links.source), `${totals.links.result} + ${totals.links.adoptedAsPages} that became the card's page`],
      ['checklist items', String(totals.checklistItems.source), String(totals.checklistItems.result)],
      ['attachments', String(totals.attachments.source), String(totals.attachments.result)],
      ['activity entries', String(totals.activityEntries.source), String(totals.activityEntries.result)],
    ]),
  );
  lines.push('');
  const from = report.checkedFrom === 'disk' ? 'the data folder, read again from disk' : 'the docs in memory';
  if (report.mismatches.length === 0) lines.push(`Checked against ${from}: everything matches.`);
  else {
    lines.push(`Checked against ${from}: ${report.mismatches.length} differences.`);
    lines.push(...report.mismatches.map((mismatch) => `  ${mismatch}`));
  }
  return `${lines.join('\n')}\n`;
}
