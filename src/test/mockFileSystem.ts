import type {
  LocalBaseHandle,
  LocalDirectoryHandle,
  LocalFileHandle,
  LocalHandlePermissionDescriptor,
} from '../lib/fileSystemTypes';

type FileSource = string | Blob | File | (() => File | Promise<File>);
interface Tree {
  [name: string]: FileSource | Tree | MockDirectoryHandle | MockFileHandle;
}

export class MockFileHandle implements LocalFileHandle {
  readonly kind = 'file';
  readonly name: string;
  private source: FileSource;

  constructor(name: string, source: FileSource) {
    this.name = name;
    this.source = source;
  }

  async getFile(): Promise<File> {
    const value = typeof this.source === 'function' ? await this.source() : this.source;

    if (value instanceof File) {
      return value;
    }

    if (value instanceof Blob) {
      return new File([value], this.name, { lastModified: 1 });
    }

    return new File([value], this.name, { lastModified: 1 });
  }

  setSource(source: FileSource): void {
    this.source = source;
  }

  async isSameEntry(other: LocalBaseHandle): Promise<boolean> {
    return this === other;
  }
}

export class MockDirectoryHandle implements LocalDirectoryHandle {
  readonly kind = 'directory';
  readonly name: string;
  readonly children = new Map<string, MockDirectoryHandle | MockFileHandle>();
  readonly removedEntries: string[] = [];
  private permissionState: PermissionState = 'granted';

  constructor(name: string, tree: Tree = {}) {
    this.name = name;

    for (const [entryName, entry] of Object.entries(tree)) {
      if (entry instanceof MockDirectoryHandle || entry instanceof MockFileHandle) {
        this.children.set(entryName, entry);
      } else if (isTree(entry)) {
        this.children.set(entryName, new MockDirectoryHandle(entryName, entry));
      } else {
        this.children.set(entryName, new MockFileHandle(entryName, entry));
      }
    }
  }

  async *entries(): AsyncIterableIterator<
    [string, MockDirectoryHandle | MockFileHandle]
  > {
    for (const entry of this.children.entries()) {
      yield entry;
    }
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.has(name)) {
      throw new DOMException('Entry not found.', 'NotFoundError');
    }

    this.children.delete(name);
    this.removedEntries.push(name);
  }

  async resolve(possibleDescendant: LocalBaseHandle): Promise<string[] | null> {
    if (possibleDescendant === this) {
      return [];
    }

    return this.findPath(possibleDescendant, []);
  }

  async isSameEntry(other: LocalBaseHandle): Promise<boolean> {
    return this === other;
  }

  async queryPermission(
    _descriptor?: LocalHandlePermissionDescriptor,
  ): Promise<PermissionState> {
    return this.permissionState;
  }

  async requestPermission(
    _descriptor?: LocalHandlePermissionDescriptor,
  ): Promise<PermissionState> {
    return this.permissionState;
  }

  setPermissionState(permissionState: PermissionState): void {
    this.permissionState = permissionState;
  }

  addFile(name: string, source: FileSource): MockFileHandle {
    const file = new MockFileHandle(name, source);
    this.children.set(name, file);
    return file;
  }

  addDirectory(name: string, tree: Tree = {}): MockDirectoryHandle {
    const directory = new MockDirectoryHandle(name, tree);
    this.children.set(name, directory);
    return directory;
  }

  getDirectory(name: string): MockDirectoryHandle {
    const entry = this.children.get(name);

    if (!(entry instanceof MockDirectoryHandle)) {
      throw new Error(`${name} is not a directory.`);
    }

    return entry;
  }

  getFileHandle(name: string): MockFileHandle {
    const entry = this.children.get(name);

    if (!(entry instanceof MockFileHandle)) {
      throw new Error(`${name} is not a file.`);
    }

    return entry;
  }

  private findPath(
    target: LocalBaseHandle,
    path: string[],
  ): string[] | null {
    for (const [name, child] of this.children) {
      const nextPath = [...path, name];

      if (child === target) {
        return nextPath;
      }

      if (child instanceof MockDirectoryHandle) {
        const nestedPath = child.findPath(target, nextPath);

        if (nestedPath) {
          return nestedPath;
        }
      }
    }

    return null;
  }
}

export class ThrowingDirectoryHandle extends MockDirectoryHandle {
  async *entries(): AsyncIterableIterator<
    [string, MockDirectoryHandle | MockFileHandle]
  > {
    throw new Error('Cannot read directory.');
  }
}

function isTree(value: unknown): value is Tree {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Blob) &&
    !(value instanceof File) &&
    !(value instanceof MockDirectoryHandle) &&
    !(value instanceof MockFileHandle)
  );
}
