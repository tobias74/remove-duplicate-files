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

  it('skips deletion when check file metadata changed after scanning', async () => {
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

  it('optionally verifies same-size file contents again before deletion', async () => {
    let currentContent = 'same';
    const authoritative = new MockDirectoryHandle('authoritative', {
      'original.txt': 'same',
    });
    const check = new MockDirectoryHandle('check');
    check.addFile('copy.txt', () => new File([currentContent], 'copy.txt'));

    const scan = await scanForDuplicates(authoritative, check);
    currentContent = 'xxxx';

    const results = await deleteDuplicateFiles(scan.duplicates, {
      verifyBeforeDelete: true,
    });

    expect(results[0]).toMatchObject({
      id: 'copy.txt',
      path: 'copy.txt',
      status: 'skipped',
    });
    expect(check.children.has('copy.txt')).toBe(true);
    expect(check.removedEntries).toEqual([]);
  });

  it('can skip byte verification before deletion for speed', async () => {
    const original = new File(['same'], 'copy.txt', { lastModified: 10 });
    let currentFile = original;
    const authoritative = new MockDirectoryHandle('authoritative', {
      'original.txt': new File(['same'], 'original.txt', { lastModified: 10 }),
    });
    const check = new MockDirectoryHandle('check');
    check.addFile('copy.txt', () => currentFile);

    const scan = await scanForDuplicates(authoritative, check);
    currentFile = new File(['xxxx'], 'copy.txt', { lastModified: 10 });

    const results = await deleteDuplicateFiles(scan.duplicates, {
      verifyBeforeDelete: false,
    });

    expect(results[0]).toMatchObject({
      id: 'copy.txt',
      path: 'copy.txt',
      status: 'deleted',
    });
    expect(check.children.has('copy.txt')).toBe(false);
    expect(check.removedEntries).toEqual(['copy.txt']);
  });
});
