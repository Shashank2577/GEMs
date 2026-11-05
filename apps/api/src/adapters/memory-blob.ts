/** In-memory BlobStore (unit tests, previews). */
import type { BlobBody, BlobObject, BlobStore } from '../deps';
import { assertSafeKey, bytesToStream, guessContentType, toBytes } from './blob-common';

export function createMemoryBlobStore(): BlobStore & { keys(): string[] } {
  const store = new Map<string, { bytes: Uint8Array; contentType: string; uploadedAt: Date }>();
  return {
    keys: () => [...store.keys()],
    async put(key: string, body: BlobBody, opts?: { contentType?: string }) {
      assertSafeKey(key);
      const bytes = await toBytes(body);
      const contentType = opts?.contentType ?? guessContentType(key);
      const uploadedAt = new Date();
      store.set(key, { bytes, contentType, uploadedAt });
      return { key, size: bytes.byteLength, contentType, uploadedAt };
    },
    async get(key: string): Promise<BlobObject | null> {
      const o = store.get(key);
      if (!o) return null;
      return {
        key, size: o.bytes.byteLength, contentType: o.contentType, uploadedAt: o.uploadedAt,
        body: bytesToStream(o.bytes),
        arrayBuffer: async () => o.bytes.slice().buffer as ArrayBuffer,
      };
    },
    async head(key: string) {
      const o = store.get(key);
      return o ? { key, size: o.bytes.byteLength, contentType: o.contentType, uploadedAt: o.uploadedAt } : null;
    },
    async delete(key: string) { store.delete(key); },
  };
}
