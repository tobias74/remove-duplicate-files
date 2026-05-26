import { describe, expect, it } from 'vitest';
import { filesEqualByContent } from './byteCompare';

describe('filesEqualByContent', () => {
  it('returns true for identical blobs', async () => {
    const left = new Blob(['abc', 'def']);
    const right = new Blob(['abcdef']);

    await expect(
      filesEqualByContent(left, right, { chunkSize: 2 }),
    ).resolves.toBe(true);
  });

  it('returns false for same-size blobs with different bytes', async () => {
    const left = new Blob(['abcdef']);
    const right = new Blob(['abcxef']);

    await expect(
      filesEqualByContent(left, right, { chunkSize: 2 }),
    ).resolves.toBe(false);
  });

  it('returns false without reading when sizes differ', async () => {
    const left = new Blob(['short']);
    const right = new Blob(['longer']);

    await expect(filesEqualByContent(left, right)).resolves.toBe(false);
  });
});
