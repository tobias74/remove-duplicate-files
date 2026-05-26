export interface CompareWorkerRequest {
  id: number;
  left: Blob;
  right: Blob;
  chunkSize: number;
}

export interface CompareWorkerResponse {
  id: number;
  equal?: boolean;
  error?: string;
}

