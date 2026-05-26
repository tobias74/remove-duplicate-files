import { throwIfAborted, toErrorMessage } from './fileSystem';
import { DEFAULT_COMPARE_CHUNK_SIZE } from './byteCompare';
import {
  createFileComparator,
  getDefaultCompareWorkerCount,
} from './fileComparator';
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
  verifyBeforeDelete?: boolean;
  compareChunkSize?: number;
  workerCount?: number;
  onProgress?: (progress: DeleteProgress) => void;
}

export async function deleteDuplicateFiles(
  candidates: readonly DuplicateCandidate[],
  options: DeleteOptions = {},
): Promise<DeleteResult[]> {
  const results: DeleteResult[] = [];
  const comparator = options.verifyBeforeDelete
    ? createFileComparator({
        workerCount: options.workerCount ?? getDefaultCompareWorkerCount(),
        chunkSize: options.compareChunkSize ?? DEFAULT_COMPARE_CHUNK_SIZE,
        signal: options.signal,
      })
    : undefined;

  try {
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
        } else if (
          !options.verifyBeforeDelete &&
          currentFile.lastModified !== candidate.lastModified
        ) {
          result = {
            id: candidate.id,
            path: candidate.path,
            status: 'skipped',
            message: 'File metadata changed since scan.',
          };
        } else if (options.verifyBeforeDelete) {
          const authoritativeFile =
            await candidate.authoritativeFile.handle.getFile();

          if (authoritativeFile.size !== candidate.authoritativeFile.size) {
            result = {
              id: candidate.id,
              path: candidate.path,
              status: 'skipped',
              message: 'Authoritative match changed since scan.',
            };
          } else if (
            !(await comparator!.compare(currentFile, authoritativeFile))
          ) {
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
        } else {
          await candidate.checkFile.parentHandle.removeEntry(candidate.name);
          result = {
            id: candidate.id,
            path: candidate.path,
            status: 'deleted',
          };
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
  } finally {
    comparator?.destroy();
  }

  return results;
}
