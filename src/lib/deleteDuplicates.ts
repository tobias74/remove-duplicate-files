import { throwIfAborted, toErrorMessage } from './fileSystem';
import { hashFile } from './hash';
import type { DuplicateCandidate } from './scanner';

export type DeleteStatus = 'deleted' | 'skipped' | 'failed';

export interface DeleteResult {
  id: string;
  path: string;
  status: DeleteStatus;
  message?: string;
}

export interface DeleteProgress {
  index: number;
  total: number;
  candidate: DuplicateCandidate;
  result: DeleteResult;
}

interface DeleteOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DeleteProgress) => void;
}

export async function deleteDuplicateFiles(
  candidates: readonly DuplicateCandidate[],
  options: DeleteOptions = {},
): Promise<DeleteResult[]> {
  const results: DeleteResult[] = [];

  for (const [index, candidate] of candidates.entries()) {
    throwIfAborted(options.signal);

    let result: DeleteResult;

    try {
      const currentFile = await candidate.checkFile.handle.getFile();

      if (currentFile.size !== candidate.size) {
        result = {
          id: candidate.id,
          path: candidate.path,
          status: 'skipped',
          message: 'File size changed since scan.',
        };
      } else {
        const currentHash = await hashFile(currentFile, {
          signal: options.signal,
        });

        if (currentHash !== candidate.hash) {
          result = {
            id: candidate.id,
            path: candidate.path,
            status: 'skipped',
            message: 'File contents changed since scan.',
          };
        } else {
          await candidate.checkFile.parentHandle.removeEntry(candidate.name);
          result = {
            id: candidate.id,
            path: candidate.path,
            status: 'deleted',
          };
        }
      }
    } catch (error) {
      result = {
        id: candidate.id,
        path: candidate.path,
        status: 'failed',
        message: toErrorMessage(error),
      };
    }

    results.push(result);
    options.onProgress?.({
      index,
      total: candidates.length,
      candidate,
      result,
    });
  }

  return results;
}

