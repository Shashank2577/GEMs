/** Cloudflare R2 BlobStore (Workers). Typed structurally so this file compiles without workers-types. */
import type { BlobBody, BlobObject, BlobStore } from '../deps';
import { assertSafeKey, guessContentType, toBytes } from './blob-common';

interface R2ObjectLike {
  key: string; size: number; uploaded?: Date;
  httpMetadata?: { contentType?: string };
}
interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
/** Minimal subset of the Workers `R2Bucket` binding. */
export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string | string[]): Promise<void>;
}

export function createR2BlobStore(bucket: R2BucketLike): BlobStore {
  const meta = (o: R2ObjectLike) => ({
    key: o.key, size: o.size, uploadedAt: o.uploaded,
    contentType: o.httpMetadata?.contentType ?? guessContentType(o.key),
  });
  return {
    async put(key: string, body: BlobBody, opts?: { contentType?: string }) {
      assertSafeKey(key);
      const bytes = await toBytes(body);
      const contentType = opts?.contentType ?? guessContentType(key);
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
      return { key, size: bytes.byteLength, contentType, uploadedAt: new Date() };
    },
    async get(key: string): Promise<BlobObject | null> {
      assertSafeKey(key);
      const o = await bucket.get(key);
      if (!o) return null;
      return { ...meta(o), body: o.body, arrayBuffer: () => o.arrayBuffer() };
    },
    async head(key: string) {
      assertSafeKey(key);
      const o = await bucket.head(key);
      return o ? meta(o) : null;
    },
    async delete(key: string) {
      assertSafeKey(key);
      await bucket.delete(key);
    },
  };
}
