import { browserDuplicateFileService } from './browserDuplicateFileService';
import { tauriDuplicateFileService } from './tauriDuplicateFileService';
import type { DuplicateFileService } from './types';

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
}

export function isTauriRuntime(): boolean {
  const maybeTauri = window as TauriWindow;
  return Boolean(maybeTauri.__TAURI_INTERNALS__ || maybeTauri.__TAURI__);
}

export function getDuplicateFileService(): DuplicateFileService {
  return isTauriRuntime() ? tauriDuplicateFileService : browserDuplicateFileService;
}

