import type { UnlistenFn } from '@tauri-apps/api/event';
import type { DeleteResult } from '../lib/deleteDuplicates';
import type {
  DuplicateCandidate,
  DuplicateScanProgress,
  DuplicateScanResult,
} from '../lib/scanner';
import type { DuplicateFileService, ServiceFolder } from './types';

interface NativeFolder extends ServiceFolder {
  kind: 'tauri';
  path: string;
}

interface NativeDeleteProgress {
  result: DeleteResult;
}

let requestCounter = 1;

export const tauriDuplicateFileService: DuplicateFileService = {
  kind: 'tauri',
  label: 'Tauri native',
  isSupported: () => true,
  async pickFolder(role) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      directory: true,
      multiple: false,
      title:
        role === 'authoritative'
          ? 'Choose authoritative folder'
          : 'Choose folder to check',
    });

    if (typeof selected !== 'string') {
      throw new DOMException('Folder selection cancelled.', 'AbortError');
    }

    return {
      kind: 'tauri',
      id: selected,
      name: getPathBasename(selected),
      path: selected,
    };
  },
  async validateFolders(authoritativeFolder, checkFolder) {
    if (
      authoritativeFolder.kind !== 'tauri' ||
      checkFolder.kind !== 'tauri' ||
      !authoritativeFolder.path ||
      !checkFolder.path
    ) {
      return 'Choose both folders again before scanning.';
    }

    return null;
  },
  async scan(authoritativeFolder, checkFolder, options) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    const requestId = createRequestId('scan');
    const progressEvent = `scan-progress-${requestId}`;
    let unlisten: UnlistenFn | undefined;

    try {
      unlisten = await listen<DuplicateScanProgress>(
        progressEvent,
        (event) => options.onProgress?.(event.payload),
      );

      options.signal?.addEventListener(
        'abort',
        () => {
          void invoke('cancel_operation', { requestId });
        },
        { once: true },
      );

      return await invoke<DuplicateScanResult>('scan_duplicates', {
        requestId,
        authoritativePath: asNativeFolder(authoritativeFolder).path,
        checkPath: asNativeFolder(checkFolder).path,
      });
    } finally {
      unlisten?.();
    }
  },
  async deleteDuplicates(candidates, options) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    const requestId = createRequestId('delete');
    const progressEvent = `delete-progress-${requestId}`;
    let unlisten: UnlistenFn | undefined;

    try {
      unlisten = await listen<NativeDeleteProgress>(
        progressEvent,
        (event) => options.onProgress?.(event.payload.result),
      );

      options.signal?.addEventListener(
        'abort',
        () => {
          void invoke('cancel_operation', { requestId });
        },
        { once: true },
      );

      return await invoke<DeleteResult[]>('delete_duplicates', {
        requestId,
        checkPath: asNativeFolder(options.checkFolder).path,
        verifyBeforeDelete: options.verifyBeforeDelete,
        candidates: candidates.map(toNativeDeleteRequest),
      });
    } finally {
      unlisten?.();
    }
  },
};

function asNativeFolder(folder: ServiceFolder): NativeFolder {
  if (folder.kind !== 'tauri' || !folder.path) {
    throw new Error('Expected a Tauri folder path.');
  }

  return folder as NativeFolder;
}

function createRequestId(prefix: string): string {
  const id = `${prefix}-${Date.now()}-${requestCounter}`;
  requestCounter += 1;
  return id;
}

function getPathBasename(path: string): string {
  const normalizedPath = path.replace(/\\/g, '/').replace(/\/$/, '');
  return normalizedPath.split('/').pop() || normalizedPath || path;
}

function toNativeDeleteRequest(candidate: DuplicateCandidate) {
  return {
    id: candidate.id,
    path: candidate.path,
    size: candidate.size,
    lastModified: candidate.lastModified,
    authoritativeAbsolutePath: candidate.authoritativeAbsolutePath,
  };
}
