import { forEachWithConcurrency } from './concurrency';
import {
  throwIfAborted,
  toErrorMessage,
  walkDirectory,
  type WalkedFile,
} from './fileSystem';
import { hashFile } from './hash';
import type { LocalDirectoryHandle } from './fileSystemTypes';

export type ScanPhase =
  | 'idle'
  | 'walking-authoritative'
  | 'walking-check'
  | 'hashing-authoritative'
  | 'hashing-check'
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
  hashedAuthoritativeFiles: number;
  hashedCheckFiles: number;
  duplicatesFound: number;
  issues: number;
  currentPath?: string;
}

export interface AuthoritativeMatch {
  path: string;
  size: number;
  hash: string;
}

export interface DuplicateCandidate {
  id: string;
  path: string;
  name: string;
  size: number;
  lastModified: number;
  hash: string;
  authoritativePath: string;
  authoritativeMatches: AuthoritativeMatch[];
  checkFile: WalkedFile;
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
  hashConcurrency?: number;
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
    hashedAuthoritativeFiles: 0,
    hashedCheckFiles: 0,
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
    phase: 'hashing-check',
    authoritativeFiles: authoritativeWalk.files.length,
    checkFiles: checkWalk.files.length,
    candidateFiles: candidateCheckFiles.length,
    skippedFiles: skippedFileCount,
    currentPath: undefined,
  });

  const hashConcurrency = options.hashConcurrency ?? 2;
  const authoritativeHashIndexes = new Map<
    number,
    Map<string, WalkedFile[]>
  >();
  const duplicates: DuplicateCandidate[] = [];

  const getAuthoritativeHashIndex = async (
    size: number,
  ): Promise<Map<string, WalkedFile[]>> => {
    const cached = authoritativeHashIndexes.get(size);

    if (cached) {
      return cached;
    }

    const filesForSize = authoritativeBySize.get(size) ?? [];
    const index = new Map<string, WalkedFile[]>();

    report({ phase: 'hashing-authoritative' });

    await forEachWithConcurrency(
      filesForSize,
      hashConcurrency,
      async (walkedFile) => {
        throwIfAborted(options.signal);

        try {
          const file = await walkedFile.handle.getFile();

          if (file.size !== walkedFile.size) {
            issues.push({
              scope: 'authoritative',
              path: walkedFile.path,
              message: 'File changed during scan and was skipped.',
            });
            return;
          }

          const hash = await hashFile(file, { signal: options.signal });
          const matchingFiles = index.get(hash) ?? [];
          matchingFiles.push(walkedFile);
          index.set(hash, matchingFiles);
        } catch (error) {
          issues.push({
            scope: 'authoritative',
            path: walkedFile.path,
            message: toErrorMessage(error),
          });
        } finally {
          progress.hashedAuthoritativeFiles += 1;
          report({
            phase: 'hashing-authoritative',
            currentPath: walkedFile.path,
          });
        }
      },
      options.signal,
    );

    authoritativeHashIndexes.set(size, index);
    return index;
  };

  for (const checkFile of candidateCheckFiles) {
    throwIfAborted(options.signal);
    const authoritativeHashIndex = await getAuthoritativeHashIndex(
      checkFile.size,
    );

    report({
      phase: 'hashing-check',
      currentPath: checkFile.path,
    });

    try {
      const file = await checkFile.handle.getFile();

      if (file.size !== checkFile.size) {
        issues.push({
          scope: 'check',
          path: checkFile.path,
          message: 'File changed during scan and was skipped.',
        });
        continue;
      }

      const hash = await hashFile(file, { signal: options.signal });
      const matches = authoritativeHashIndex.get(hash);

      if (matches && matches.length > 0) {
        const authoritativeMatches = matches.map((match) => ({
          path: match.path,
          size: match.size,
          hash,
        }));

        duplicates.push({
          id: checkFile.path,
          path: checkFile.path,
          name: checkFile.name,
          size: checkFile.size,
          lastModified: checkFile.lastModified,
          hash,
          authoritativePath: authoritativeMatches[0].path,
          authoritativeMatches,
          checkFile,
        });
      }
    } catch (error) {
      issues.push({
        scope: 'check',
        path: checkFile.path,
        message: toErrorMessage(error),
      });
    } finally {
      progress.hashedCheckFiles += 1;
      report({
        phase: 'hashing-check',
        duplicatesFound: duplicates.length,
        currentPath: checkFile.path,
      });
    }
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

