import { forEachWithConcurrency } from './concurrency';
import {
  DEFAULT_COMPARE_CHUNK_SIZE,
} from './byteCompare';
import {
  createFileComparator,
  getDefaultCompareWorkerCount,
} from './fileComparator';
import {
  throwIfAborted,
  toErrorMessage,
  walkDirectory,
  type WalkedFile,
} from './fileSystem';
import type { LocalDirectoryHandle } from './fileSystemTypes';

export type ScanPhase =
  | 'idle'
  | 'walking-authoritative'
  | 'walking-check'
  | 'comparing'
  | 'complete';

export interface ScanIssue {
  scope: 'authoritative' | 'check';
  path: string;
  message: string;
}

export interface DuplicateScanProgress {
  phase: ScanPhase;
  authoritativeFiles: number;
  checkFiles: number;
  candidateFiles: number;
  skippedFiles: number;
  comparedCheckFiles: number;
  comparedPairs: number;
  duplicatesFound: number;
  issues: number;
  currentPath?: string;
}

export interface AuthoritativeMatch {
  path: string;
  size: number;
}

export interface DuplicateCandidate {
  id: string;
  path: string;
  name: string;
  size: number;
  lastModified: number;
  authoritativePath: string;
  authoritativeAbsolutePath?: string;
  authoritativeMatches: AuthoritativeMatch[];
  checkFile: WalkedFile;
  authoritativeFile: WalkedFile;
}

export interface DuplicateScanResult {
  authoritativeFileCount: number;
  checkFileCount: number;
  candidateFileCount: number;
  skippedFileCount: number;
  duplicates: DuplicateCandidate[];
  issues: ScanIssue[];
}

interface ScanOptions {
  signal?: AbortSignal;
  compareConcurrency?: number;
  compareChunkSize?: number;
  workerCount?: number;
  onProgress?: (progress: DuplicateScanProgress) => void;
}

export async function scanForDuplicates(
  authoritativeRoot: LocalDirectoryHandle,
  checkRoot: LocalDirectoryHandle,
  options: ScanOptions = {},
): Promise<DuplicateScanResult> {
  const issues: ScanIssue[] = [];
  const progress: DuplicateScanProgress = {
    phase: 'idle',
    authoritativeFiles: 0,
    checkFiles: 0,
    candidateFiles: 0,
    skippedFiles: 0,
    comparedCheckFiles: 0,
    comparedPairs: 0,
    duplicatesFound: 0,
    issues: 0,
  };

  const report = (patch: Partial<DuplicateScanProgress> = {}) => {
    Object.assign(progress, patch, { issues: issues.length });
    options.onProgress?.({ ...progress });
  };

  report({ phase: 'walking-authoritative' });
  const authoritativeWalk = await walkDirectory(authoritativeRoot, {
    signal: options.signal,
    onProgress: (walkProgress) => {
      report({
        phase: 'walking-authoritative',
        authoritativeFiles: walkProgress.files,
        currentPath: walkProgress.currentPath,
      });
    },
  });

  for (const error of authoritativeWalk.errors) {
    issues.push({ scope: 'authoritative', ...error });
  }

  report({
    phase: 'walking-check',
    authoritativeFiles: authoritativeWalk.files.length,
  });

  const checkWalk = await walkDirectory(checkRoot, {
    signal: options.signal,
    onProgress: (walkProgress) => {
      report({
        phase: 'walking-check',
        checkFiles: walkProgress.files,
        currentPath: walkProgress.currentPath,
      });
    },
  });

  for (const error of checkWalk.errors) {
    issues.push({ scope: 'check', ...error });
  }

  const authoritativeBySize = groupFilesBySize(authoritativeWalk.files);
  const candidateCheckFiles = checkWalk.files.filter((file) =>
    authoritativeBySize.has(file.size),
  );
  const skippedFileCount = checkWalk.files.length - candidateCheckFiles.length;

  report({
    phase: 'comparing',
    authoritativeFiles: authoritativeWalk.files.length,
    checkFiles: checkWalk.files.length,
    candidateFiles: candidateCheckFiles.length,
    skippedFiles: skippedFileCount,
    currentPath: undefined,
  });

  const compareConcurrency =
    options.compareConcurrency ?? getDefaultCompareWorkerCount();
  const comparator = createFileComparator({
    workerCount: options.workerCount ?? compareConcurrency,
    chunkSize: options.compareChunkSize ?? DEFAULT_COMPARE_CHUNK_SIZE,
    signal: options.signal,
  });
  const duplicates: DuplicateCandidate[] = [];

  try {
    await forEachWithConcurrency(
      candidateCheckFiles,
      compareConcurrency,
      async (checkFile) => {
        throwIfAborted(options.signal);

        try {
          const checkBlob = await checkFile.handle.getFile();

          if (checkBlob.size !== checkFile.size) {
            issues.push({
              scope: 'check',
              path: checkFile.path,
              message: 'File changed during scan and was skipped.',
            });
            return;
          }

          const sameSizeAuthoritativeFiles =
            authoritativeBySize.get(checkFile.size) ?? [];

          for (const authoritativeFile of sameSizeAuthoritativeFiles) {
            throwIfAborted(options.signal);
            progress.comparedPairs += 1;
            report({
              phase: 'comparing',
              currentPath: `${checkFile.path} vs ${authoritativeFile.path}`,
            });

            let authoritativeBlob: File;

            try {
              authoritativeBlob = await authoritativeFile.handle.getFile();
            } catch (error) {
              issues.push({
                scope: 'authoritative',
                path: authoritativeFile.path,
                message: toErrorMessage(error),
              });
              continue;
            }

            if (authoritativeBlob.size !== authoritativeFile.size) {
              issues.push({
                scope: 'authoritative',
                path: authoritativeFile.path,
                message: 'File changed during scan and was skipped.',
              });
              continue;
            }

            const isDuplicate = await comparator.compare(
              checkBlob,
              authoritativeBlob,
            );

            if (isDuplicate) {
              const authoritativeMatch = {
                path: authoritativeFile.path,
                size: authoritativeFile.size,
              };

              duplicates.push({
                id: checkFile.path,
                path: checkFile.path,
                name: checkFile.name,
                size: checkFile.size,
                lastModified: checkFile.lastModified,
                authoritativePath: authoritativeMatch.path,
                authoritativeMatches: [authoritativeMatch],
                checkFile,
                authoritativeFile,
              });
              break;
            }
          }
        } catch (error) {
          issues.push({
            scope: 'check',
            path: checkFile.path,
            message: toErrorMessage(error),
          });
        } finally {
          progress.comparedCheckFiles += 1;
          report({
            phase: 'comparing',
            duplicatesFound: duplicates.length,
            currentPath: checkFile.path,
          });
        }
      },
      options.signal,
    );
  } finally {
    comparator.destroy();
  }

  report({
    phase: 'complete',
    duplicatesFound: duplicates.length,
    currentPath: undefined,
  });

  return {
    authoritativeFileCount: authoritativeWalk.files.length,
    checkFileCount: checkWalk.files.length,
    candidateFileCount: candidateCheckFiles.length,
    skippedFileCount,
    duplicates,
    issues,
  };
}

function groupFilesBySize(files: readonly WalkedFile[]): Map<number, WalkedFile[]> {
  const filesBySize = new Map<number, WalkedFile[]>();

  for (const file of files) {
    const filesForSize = filesBySize.get(file.size) ?? [];
    filesForSize.push(file);
    filesBySize.set(file.size, filesForSize);
  }

  return filesBySize;
}
