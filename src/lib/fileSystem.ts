import type {
  DirectoryPickerWindow,
  LocalBaseHandle,
  LocalDirectoryHandle,
  LocalFileHandle,
  LocalPermissionMode,
} from './fileSystemTypes';

export interface WalkedFile {
  id: string;
  name: string;
  path: string;
  size: number;
  lastModified: number;
  handle: LocalFileHandle;
  parentHandle: LocalDirectoryHandle;
}

export interface WalkIssue {
  path: string;
  message: string;
}

export interface WalkProgress {
  directories: number;
  files: number;
  errors: number;
  currentPath?: string;
}

export interface WalkResult {
  directories: number;
  files: WalkedFile[];
  errors: WalkIssue[];
}

export type DirectoryRelationship =
  | 'same'
  | 'authoritative-contains-check'
  | 'check-contains-authoritative'
  | 'separate'
  | 'unknown';

export function isFileSystemAccessSupported(win: Window = window): boolean {
  return typeof (win as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

export async function pickDirectory(
  id: string,
  mode: LocalPermissionMode = 'read',
): Promise<LocalDirectoryHandle> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;

  if (!picker) {
    throw new Error('This browser does not support local folder access.');
  }

  return picker({ id, mode });
}

export async function requestDirectoryPermission(
  handle: LocalDirectoryHandle,
  mode: LocalPermissionMode,
): Promise<PermissionState> {
  const descriptor = { mode };
  const current = await handle.queryPermission?.(descriptor);

  if (current === 'granted') {
    return current;
  }

  if (!handle.requestPermission) {
    return current ?? 'prompt';
  }

  return handle.requestPermission(descriptor);
}

export async function walkDirectory(
  root: LocalDirectoryHandle,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: WalkProgress) => void;
  } = {},
): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const errors: WalkIssue[] = [];
  let directories = 0;

  const report = (currentPath?: string) => {
    options.onProgress?.({
      directories,
      files: files.length,
      errors: errors.length,
      currentPath,
    });
  };

  const visit = async (
    directory: LocalDirectoryHandle,
    basePath: string,
  ): Promise<void> => {
    throwIfAborted(options.signal);
    directories += 1;
    report(basePath || directory.name);

    try {
      for await (const [entryName, handle] of directory.entries()) {
        throwIfAborted(options.signal);
        const entryPath = joinPath(basePath, entryName);

        if (handle.kind === 'directory') {
          await visit(handle, entryPath);
          continue;
        }

        try {
          const file = await handle.getFile();
          files.push({
            id: entryPath,
            name: entryName,
            path: entryPath,
            size: file.size,
            lastModified: file.lastModified,
            handle,
            parentHandle: directory,
          });
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }

          errors.push({
            path: entryPath,
            message: toErrorMessage(error),
          });
        }

        report(entryPath);
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      errors.push({
        path: basePath || directory.name,
        message: toErrorMessage(error),
      });
      report(basePath || directory.name);
    }
  };

  await visit(root, '');

  return {
    directories,
    files,
    errors,
  };
}

export async function getDirectoryRelationship(
  authoritative: LocalDirectoryHandle,
  check: LocalDirectoryHandle,
): Promise<DirectoryRelationship> {
  if (await areSameEntry(authoritative, check)) {
    return 'same';
  }

  let attemptedResolve = false;
  let resolveFailed = false;

  if (authoritative.resolve) {
    attemptedResolve = true;

    try {
      const relativePath = await authoritative.resolve(check);

      if (relativePath !== null) {
        return 'authoritative-contains-check';
      }
    } catch {
      resolveFailed = true;
    }
  }

  if (check.resolve) {
    attemptedResolve = true;

    try {
      const relativePath = await check.resolve(authoritative);

      if (relativePath !== null) {
        return 'check-contains-authoritative';
      }
    } catch {
      resolveFailed = true;
    }
  }

  if (!attemptedResolve || resolveFailed) {
    return 'unknown';
  }

  return 'separate';
}

export function describeUnsafeRelationship(
  relationship: DirectoryRelationship,
): string | null {
  switch (relationship) {
    case 'same':
      return 'Choose two different folders before scanning.';
    case 'authoritative-contains-check':
      return 'The folder to check is inside the authoritative folder. Choose separate folders to avoid deleting protected content.';
    case 'check-contains-authoritative':
      return 'The authoritative folder is inside the folder to check. Choose separate folders to keep authoritative files protected.';
    default:
      return null;
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    return `${error.name}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (error instanceof Error && error.name === 'AbortError');
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Operation cancelled.', 'AbortError');
  }

  const error = new Error('Operation cancelled.');
  error.name = 'AbortError';
  return error;
}

async function areSameEntry(
  first: LocalBaseHandle,
  second: LocalBaseHandle,
): Promise<boolean> {
  if (first === second) {
    return true;
  }

  if (!first.isSameEntry) {
    return false;
  }

  try {
    return await first.isSameEntry(second);
  } catch {
    return false;
  }
}

function joinPath(parentPath: string, entryName: string): string {
  return parentPath ? `${parentPath}/${entryName}` : entryName;
}

