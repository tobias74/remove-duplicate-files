import { describe, expect, it } from 'vitest';
import {
  getDirectoryRelationship,
  walkDirectory,
} from './fileSystem';
import {
  MockDirectoryHandle,
  MockFileHandle,
  ThrowingDirectoryHandle,
} from '../test/mockFileSystem';

describe('walkDirectory', () => {
  it('recursively walks files and preserves relative paths', async () => {
    const root = new MockDirectoryHandle('root', {
      'a.txt': 'alpha',
      nested: {
        'b.txt': 'beta',
      },
    });

    const result = await walkDirectory(root);

    expect(result.directories).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.files.map((file) => file.path).sort()).toEqual([
      'a.txt',
      'nested/b.txt',
    ]);
  });

  it('records file and directory read errors without dropping other files', async () => {
    const badFile = new MockFileHandle('bad.txt', () => {
      throw new Error('Cannot read file.');
    });
    const badDirectory = new ThrowingDirectoryHandle('blocked');
    const root = new MockDirectoryHandle('root', {
      'ok.txt': 'ok',
      'bad.txt': badFile,
      blocked: badDirectory,
    });

    const result = await walkDirectory(root);

    expect(result.files.map((file) => file.path)).toEqual(['ok.txt']);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((error) => error.path).sort()).toEqual([
      'bad.txt',
      'blocked',
    ]);
  });
});

describe('getDirectoryRelationship', () => {
  it('detects same and overlapping folders', async () => {
    const root = new MockDirectoryHandle('root');
    const child = root.addDirectory('child');
    const separate = new MockDirectoryHandle('separate');

    await expect(getDirectoryRelationship(root, root)).resolves.toBe('same');
    await expect(getDirectoryRelationship(root, child)).resolves.toBe(
      'authoritative-contains-check',
    );
    await expect(getDirectoryRelationship(child, root)).resolves.toBe(
      'check-contains-authoritative',
    );
    await expect(getDirectoryRelationship(root, separate)).resolves.toBe(
      'separate',
    );
  });
});

