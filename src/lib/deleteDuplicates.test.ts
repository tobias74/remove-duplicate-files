import { describe, expect, it } from 'vitest';
import { deleteDuplicateFiles } from './deleteDuplicates';
import { scanForDuplicates } from './scanner';
import { MockDirectoryHandle } from '../test/mockFileSystem';

describe('deleteDuplicateFiles', () => {
  it('deletes matching files only from the folder to check', async () => {
    const authoritative = new MockDirectoryHandle('authoritative', {
      'original.txt': 'same',
    });
    const check = new MockDirectoryHandle('check', {
      'copy.txt': 'same',
    });
    const scan = await scanForDuplicates(authoritative, check);

    const results = await deleteDuplicateFiles(scan.duplicates);

    expect(results).toEqual([
      {
        id: 'copy.txt',
        path: 'copy.txt',
        status: 'deleted',
      },
    ]);
    expect(check.children.has('copy.txt')).toBe(false);
    expect(check.removedEntries).toEqual(['copy.txt']);
    expect(authoritative.children.has('original.txt')).toBe(true);
    expect(authoritative.removedEntries).toEqual([]);
  });

  it('skips deletion when the check file changed after scanning', async () => {
    let currentContent = 'same';
    const authoritative = new MockDirectoryHandle('authoritative', {
      'original.txt': 'same',
    });
    const check = new MockDirectoryHandle('check');
    check.addFile('copy.txt', () => new File([currentContent], 'copy.txt'));

    const scan = await scanForDuplicates(authoritative, check);
    currentContent = 'changed';

    const results = await deleteDuplicateFiles(scan.duplicates);

    expect(results[0]).toMatchObject({
      id: 'copy.txt',
      path: 'copy.txt',
      status: 'skipped',
    });
    expect(check.children.has('copy.txt')).toBe(true);
    expect(check.removedEntries).toEqual([]);
  });
});

