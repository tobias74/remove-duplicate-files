import { describe, expect, it } from 'vitest';
import { scanForDuplicates } from './scanner';
import { MockDirectoryHandle } from '../test/mockFileSystem';

describe('scanForDuplicates', () => {
  it('finds same-content files anywhere under the authoritative folder', async () => {
    const authoritative = new MockDirectoryHandle('authoritative', {
      nested: {
        'original.txt': 'same bytes',
      },
    });
    const check = new MockDirectoryHandle('check', {
      'copy-with-new-name.txt': 'same bytes',
    });

    const result = await scanForDuplicates(authoritative, check);

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]).toMatchObject({
      path: 'copy-with-new-name.txt',
      authoritativePath: 'nested/original.txt',
    });
  });

  it('does not match same-name files with different content', async () => {
    const authoritative = new MockDirectoryHandle('authoritative', {
      'report.txt': 'abc123',
    });
    const check = new MockDirectoryHandle('check', {
      'report.txt': 'abc124',
    });

    const result = await scanForDuplicates(authoritative, check);

    expect(result.duplicates).toEqual([]);
    expect(result.candidateFileCount).toBe(1);
  });

  it('skips files when no authoritative file has the same size', async () => {
    const authoritative = new MockDirectoryHandle('authoritative', {
      'short.txt': 'short',
    });
    const check = new MockDirectoryHandle('check', {
      'long.txt': 'a longer file',
    });

    const result = await scanForDuplicates(authoritative, check);

    expect(result.duplicates).toEqual([]);
    expect(result.candidateFileCount).toBe(0);
    expect(result.skippedFileCount).toBe(1);
  });

  it('stops after the first authoritative match for speed', async () => {
    const authoritative = new MockDirectoryHandle('authoritative', {
      'first.txt': 'shared',
      nested: {
        'second.txt': 'shared',
      },
    });
    const check = new MockDirectoryHandle('check', {
      'copy.txt': 'shared',
    });

    const result = await scanForDuplicates(authoritative, check);

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].authoritativeMatches).toEqual([
      {
        path: 'first.txt',
        size: 6,
      },
    ]);
  });
});
