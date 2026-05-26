import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { throwIfAborted } from './fileSystem';

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

export interface HashFileOptions {
  chunkSize?: number;
  signal?: AbortSignal;
  onChunk?: (bytesRead: number) => void;
}

export async function hashFile(
  file: Blob,
  options: HashFileOptions = {},
): Promise<string> {
  const hasher = sha256.create();
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

  if (typeof file.stream === 'function') {
    const reader = file.stream().getReader();

    try {
      while (true) {
        throwIfAborted(options.signal);
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (value.byteLength > 0) {
          hasher.update(value);
          options.onChunk?.(value.byteLength);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      throwIfAborted(options.signal);
      const chunk = file.slice(offset, offset + chunkSize);
      const bytes = new Uint8Array(await chunk.arrayBuffer());
      hasher.update(bytes);
      options.onChunk?.(bytes.byteLength);
    }
  }

  return bytesToHex(hasher.digest());
}

