import { deleteDuplicateFiles } from '../lib/deleteDuplicates';
import {
  describeUnsafeRelationship,
  getDirectoryRelationship,
  isFileSystemAccessSupported,
  pickDirectory,
  requestDirectoryPermission,
} from '../lib/fileSystem';
import type { LocalDirectoryHandle } from '../lib/fileSystemTypes';
import { scanForDuplicates } from '../lib/scanner';
import type { DuplicateFileService, ServiceFolder } from './types';

function asDirectoryHandle(folder: ServiceFolder): LocalDirectoryHandle {
  return folder.handle as LocalDirectoryHandle;
}

export const browserDuplicateFileService: DuplicateFileService = {
  kind: 'browser',
  label: 'Browser',
  isSupported: isFileSystemAccessSupported,
  async pickFolder(role) {
    const handle = await pickDirectory(
      role === 'authoritative' ? 'authoritative-folder' : 'check-folder',
      'read',
    );

    return {
      kind: 'browser',
      id: handle.name,
      name: handle.name,
      handle,
    };
  },
  async validateFolders(authoritativeFolder, checkFolder) {
    const relationship = await getDirectoryRelationship(
      asDirectoryHandle(authoritativeFolder),
      asDirectoryHandle(checkFolder),
    );

    return describeUnsafeRelationship(relationship);
  },
  scan(authoritativeFolder, checkFolder, options) {
    return scanForDuplicates(
      asDirectoryHandle(authoritativeFolder),
      asDirectoryHandle(checkFolder),
      {
        signal: options.signal,
        onProgress: options.onProgress,
      },
    );
  },
  async deleteDuplicates(candidates, options) {
    const permission = await requestDirectoryPermission(
      asDirectoryHandle(options.checkFolder),
      'readwrite',
    );

    if (permission !== 'granted') {
      throw new Error('Read/write permission was not granted for the folder to check.');
    }

    return deleteDuplicateFiles(candidates, {
      signal: options.signal,
      verifyBeforeDelete: options.verifyBeforeDelete,
      onProgress: ({ result }) => options.onProgress?.(result),
    });
  },
};

