/// <reference lib="webworker" />

import { filesEqualByContent } from '../lib/byteCompare';
import { toErrorMessage } from '../lib/fileSystem';
import type {
  CompareWorkerRequest,
  CompareWorkerResponse,
} from '../lib/compareWorkerTypes';

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = async (event: MessageEvent<CompareWorkerRequest>) => {
  const { id, left, right, chunkSize } = event.data;

  try {
    const equal = await filesEqualByContent(left, right, { chunkSize });
    const response: CompareWorkerResponse = { id, equal };
    worker.postMessage(response);
  } catch (error) {
    const response: CompareWorkerResponse = {
      id,
      error: toErrorMessage(error),
    };
    worker.postMessage(response);
  }
};

