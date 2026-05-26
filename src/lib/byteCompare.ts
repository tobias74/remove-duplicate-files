import { throwIfAborted } from './fileSystem';

export const DEFAULT_COMPARE_CHUNK_SIZE = 8 * 1024 * 1024;

export interface ByteCompareOptions {
  chunkSize?: number;
  signal?: AbortSignal;
  onProgress?: (bytesRead: number) => void;
}

export async function filesEqualByContent(
  left: Blob,
  right: Blob,
  options: ByteCompareOptions = {},
): Promise<boolean> {
  if (left.size !== right.size) {
    return false;
  }

  const chunkSize = options.chunkSize ?? DEFAULT_COMPARE_CHUNK_SIZE;

  for (let offset = 0; offset < left.size; offset += chunkSize) {
    throwIfAborted(options.signal);

    const end = Math.min(offset + chunkSize, left.size);
    const [leftBuffer, rightBuffer] = await Promise.all([
      left.slice(offset, end).arrayBuffer(),
      right.slice(offset, end).arrayBuffer(),
    ]);

    if (!arrayBuffersEqual(leftBuffer, rightBuffer)) {
      return false;
    }

    options.onProgress?.((end - offset) * 2);
  }

  return true;
}

function arrayBuffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  const wordLength = Math.floor(left.byteLength / 4);
  const leftWords = new Uint32Array(left, 0, wordLength);
  const rightWords = new Uint32Array(right, 0, wordLength);

  for (let index = 0; index < wordLength; index += 1) {
    if (leftWords[index] !== rightWords[index]) {
      return false;
    }
  }

  const byteOffset = wordLength * 4;
  const leftBytes = new Uint8Array(left, byteOffset);
  const rightBytes = new Uint8Array(right, byteOffset);

  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return false;
    }
  }

  return true;
}

