import type { DeleteResult } from '../lib/deleteDuplicates';
import type {
  DuplicateScanProgress,
  DuplicateScanResult,
  ScanIssue,
} from '../lib/scanner';

export type FolderRole = 'authoritative' | 'check';
export type RuntimeKind = 'browser' | 'tauri';

export interface ServiceFolder {
  kind: RuntimeKind;
  id: string;
  name: string;
  path?: string;
  handle?: unknown;
}

export interface DuplicateFileService {
  kind: RuntimeKind;
  label: string;
  isSupported: () => boolean;
  pickFolder: (role: FolderRole) => Promise<ServiceFolder>;
  validateFolders: (
    authoritativeFolder: ServiceFolder,
    checkFolder: ServiceFolder,
  ) => Promise<string | null>;
  scan: (
    authoritativeFolder: ServiceFolder,
    checkFolder: ServiceFolder,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: DuplicateScanProgress) => void;
    },
  ) => Promise<DuplicateScanResult>;
  deleteDuplicates: (
    candidates: readonly DuplicateScanResult['duplicates'][number][],
    options: {
      checkFolder: ServiceFolder;
      verifyBeforeDelete: boolean;
      signal?: AbortSignal;
      onProgress?: (result: DeleteResult) => void;
    },
  ) => Promise<DeleteResult[]>;
}

export type {
  DeleteResult,
  DuplicateScanProgress,
  DuplicateScanResult,
  ScanIssue,
};

