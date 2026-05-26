export type LocalPermissionMode = 'read' | 'readwrite';

export interface LocalHandlePermissionDescriptor {
  mode?: LocalPermissionMode;
}

export interface LocalBaseHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  isSameEntry?: (other: LocalBaseHandle) => Promise<boolean>;
  queryPermission?: (
    descriptor?: LocalHandlePermissionDescriptor,
  ) => Promise<PermissionState>;
  requestPermission?: (
    descriptor?: LocalHandlePermissionDescriptor,
  ) => Promise<PermissionState>;
}

export interface LocalFileHandle extends LocalBaseHandle {
  readonly kind: 'file';
  getFile: () => Promise<File>;
}

export interface LocalDirectoryHandle extends LocalBaseHandle {
  readonly kind: 'directory';
  entries: () => AsyncIterableIterator<
    [string, LocalFileHandle | LocalDirectoryHandle]
  >;
  removeEntry: (
    name: string,
    options?: {
      recursive?: boolean;
    },
  ) => Promise<void>;
  resolve?: (possibleDescendant: LocalBaseHandle) => Promise<string[] | null>;
}

export interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: LocalPermissionMode;
    startIn?: LocalDirectoryHandle | string;
  }) => Promise<LocalDirectoryHandle>;
}

