import {
  DEFAULT_COMPARE_CHUNK_SIZE,
  filesEqualByContent,
} from './byteCompare';
import type {
  CompareWorkerRequest,
  CompareWorkerResponse,
} from './compareWorkerTypes';

interface FileComparatorOptions {
  workerCount?: number;
  chunkSize?: number;
  signal?: AbortSignal;
}

export interface FileComparator {
  compare: (left: Blob, right: Blob) => Promise<boolean>;
  destroy: () => void;
}

export function createFileComparator(
  options: FileComparatorOptions = {},
): FileComparator {
  if (typeof Worker === 'undefined') {
    return createDirectComparator(options);
  }

  return new WorkerFileComparator(options);
}

export function getDefaultCompareWorkerCount(): number {
  const hardwareConcurrency =
    typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4;

  return Math.max(1, Math.min(4, Math.floor(hardwareConcurrency / 2) || 1));
}

function createDirectComparator(
  options: FileComparatorOptions,
): FileComparator {
  const chunkSize = options.chunkSize ?? DEFAULT_COMPARE_CHUNK_SIZE;

  return {
    compare: (left, right) =>
      filesEqualByContent(left, right, {
        chunkSize,
        signal: options.signal,
      }),
    destroy: () => undefined,
  };
}

interface PendingCompare {
  id: number;
  left: Blob;
  right: Blob;
  resolve: (equal: boolean) => void;
  reject: (error: Error) => void;
}

class WorkerFileComparator implements FileComparator {
  private readonly chunkSize: number;
  private readonly workers: Worker[] = [];
  private readonly availableWorkers: Worker[] = [];
  private readonly queue: PendingCompare[] = [];
  private readonly inFlight = new Map<number, PendingCompare>();
  private readonly workerTasks = new Map<Worker, number>();
  private nextId = 1;
  private destroyed = false;

  constructor(options: FileComparatorOptions) {
    this.chunkSize = options.chunkSize ?? DEFAULT_COMPARE_CHUNK_SIZE;
    const workerCount = options.workerCount ?? getDefaultCompareWorkerCount();

    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(
        new URL('../workers/compareWorker.ts', import.meta.url),
        { type: 'module' },
      );

      worker.onmessage = (event: MessageEvent<CompareWorkerResponse>) =>
        this.handleWorkerMessage(worker, event.data);
      worker.onerror = (event) => {
        this.handleWorkerFailure(
          worker,
          new Error(event.message || 'File comparison worker failed.'),
        );
      };

      this.workers.push(worker);
      this.availableWorkers.push(worker);
    }

    options.signal?.addEventListener(
      'abort',
      () => this.destroy(new DOMException('Operation cancelled.', 'AbortError')),
      { once: true },
    );
  }

  compare(left: Blob, right: Blob): Promise<boolean> {
    if (this.destroyed) {
      return Promise.reject(new Error('File comparator was stopped.'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        id: this.nextId,
        left,
        right,
        resolve,
        reject,
      });
      this.nextId += 1;
      this.pump();
    });
  }

  destroy(error = new Error('File comparator was stopped.')): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    for (const worker of this.workers) {
      worker.terminate();
    }

    for (const task of this.queue.splice(0)) {
      task.reject(error);
    }

    for (const task of this.inFlight.values()) {
      task.reject(error);
    }

    this.inFlight.clear();
    this.availableWorkers.length = 0;
  }

  private pump(): void {
    while (
      !this.destroyed &&
      this.queue.length > 0 &&
      this.availableWorkers.length > 0
    ) {
      const worker = this.availableWorkers.shift()!;
      const task = this.queue.shift()!;
      this.inFlight.set(task.id, task);
      this.workerTasks.set(worker, task.id);

      const request: CompareWorkerRequest = {
        id: task.id,
        left: task.left,
        right: task.right,
        chunkSize: this.chunkSize,
      };

      worker.postMessage(request);
    }
  }

  private handleWorkerMessage(
    worker: Worker,
    response: CompareWorkerResponse,
  ): void {
    const task = this.inFlight.get(response.id);

    if (!task) {
      return;
    }

    this.inFlight.delete(response.id);
    this.workerTasks.delete(worker);
    this.availableWorkers.push(worker);

    if (response.error) {
      task.reject(new Error(response.error));
    } else {
      task.resolve(response.equal === true);
    }

    this.pump();
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    const failedTaskId = this.workerTasks.get(worker);
    const failedTask =
      failedTaskId === undefined ? undefined : this.inFlight.get(failedTaskId);
    const availableIndex = this.availableWorkers.indexOf(worker);

    worker.terminate();
    this.workerTasks.delete(worker);

    if (availableIndex !== -1) {
      this.availableWorkers.splice(availableIndex, 1);
    }

    if (failedTask) {
      this.inFlight.delete(failedTask.id);
      failedTask.reject(error);
    }

    this.pump();
  }
}
