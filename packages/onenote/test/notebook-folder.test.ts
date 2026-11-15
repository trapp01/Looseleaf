import { describe, expect, it } from 'vitest';
import { readNotebookFolder, readNotebookFolderLazily } from '../src/index.js';
import { isNewerBackup, parseBackupName, planNotebook } from '../src/notebook-folder.js';
import { buildSectionFile } from './section-fixture.js';

describe('backup names', () => {
  it('cleans every backup suffix form', () => {
    expect(parseBackupName('Notes.one')).toEqual({ name: 'Notes' });
    expect(parseBackupName('Notes (On 2024-05-01).one')).toEqual({ name: 'Notes', date: '2024-05-01', copy: 0 });
    expect(parseBackupName('Notes.one (On 2024-05-01).one')).toEqual({ name: 'Notes', date: '2024-05-01', copy: 0 });
    expect(parseBackupName('Notes (On 2024-05-01 - 2).one')).toEqual({ name: 'Notes', date: '2024-05-01', copy: 2 });
    expect(parseBackupName('My Notes.one (On 2024-05-01).one (On 2024-06-09).one')).toEqual({ name: 'My Notes', date: '2024-06-09', copy: 0 });
    expect(parseBackupName('Trip (On the road).one')).toEqual({ name: 'Trip (On the road)' });
  });

  it('ranks the live file above backups, then by date, then by copy number', () => {
    expect(isNewerBackup({}, { date: '2030-01-01', copy: 0 })).toBe(true);
    expect(isNewerBackup({ date: '2024-06-01', copy: 0 }, { date: '2024-05-01', copy: 9 })).toBe(true);
    expect(isNewerBackup({ date: '2024-05-01', copy: 1 }, { date: '2024-05-01', copy: 0 })).toBe(true);
    expect(isNewerBackup({ date: '2024-05-01', copy: 0 }, { date: '2024-05-01', copy: 0 })).toBe(false);
  });
});

describe('planNotebook', () => {
  it('keeps the newest copy of each section, maps folders to groups and skips the recycle bin', () => {
    const plan = planNotebook([
      'Work.one (On 2024-05-01).one',
      'Work.one (On 2024-06-01).one',
      'Work (On 2024-05-20 - 1).one',
      'Projects\\Alpha.one (On 2024-01-01).one',
      'OneNote_RecycleBin/OneNote_DeletedPages.one (On 2024-06-01).one',
      '.DS_Store',
      'Open Notebook.onetoc2',
    ]);
    expect(plan).toEqual([
      { groups: [], name: 'Work', path: 'Work.one (On 2024-06-01).one' },
      { groups: ['Projects'], name: 'Alpha', path: 'Projects\\Alpha.one (On 2024-01-01).one' },
    ]);
  });
});

describe('readNotebookFolder', () => {
  const work = buildSectionFile([{ title: 'Plan', paragraphs: ['Do it'] }]);
  const older = buildSectionFile([{ title: 'Old plan', paragraphs: [] }]);
  const alpha = buildSectionFile([{ title: 'Alpha page', paragraphs: [] }]);
  const files = [
    { path: 'Work.one (On 2024-06-01).one', bytes: work },
    { path: 'Work.one (On 2024-05-01).one', bytes: older },
    { path: 'Group/Alpha.one (On 2024-01-01).one', bytes: alpha },
    { path: 'Broken.one', bytes: Uint8Array.from([1, 2, 3]) },
  ];

  it('builds groups, cleans names, keeps the newest backup and sorts sections before groups', () => {
    const notebook = readNotebookFolder(files, { name: 'Book' });
    expect(notebook.name).toBe('Book');
    expect(notebook.children.map((c) => [c.kind, c.name])).toEqual([
      ['section', 'Broken'],
      ['section', 'Work'],
      ['group', 'Group'],
    ]);
    const workSection = notebook.children[1];
    expect(workSection?.kind === 'section' && workSection.pages.map((p) => p.title)).toEqual(['Plan']);
    const group = notebook.children[2];
    expect(group?.kind === 'group' && group.children.map((c) => c.name)).toEqual(['Alpha']);
  });

  it('turns an unreadable section into a page that carries the reason', () => {
    const broken = readNotebookFolder(files, { name: 'Book' }).children[0];
    expect(broken?.kind === 'section' && broken.pages[0]!.warnings[0]).toMatch(/^This section could not be imported: Broken: Not a OneNote section/);
  });

  it('reads lazily, opening only the files it keeps, one at a time', async () => {
    const opened: string[] = [];
    const lazy = files.map((file) => ({
      path: file.path,
      read: async () => {
        opened.push(file.path);
        return file.bytes;
      },
    }));
    const notebook = await readNotebookFolderLazily(lazy, { name: 'Book' });
    expect(notebook).toEqual(readNotebookFolder(files, { name: 'Book' }));
    expect(opened).not.toContain('Work.one (On 2024-05-01).one');
    expect(opened).toHaveLength(3);
  });
});
