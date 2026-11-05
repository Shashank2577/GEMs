/** Review S6 (008/FR-070): the R2 BlobStore deletes many keys with R2's `delete(keys[])`, ≤ 1,000 keys per call. */
import { describe, expect, it } from 'vitest';
import { R2_DELETE_BATCH, createR2BlobStore, type R2BucketLike } from '../src/adapters/blob-r2';

describe('R2 BlobStore deleteMany', () => {
  it('chunks keys into delete(keys[]) calls of at most 1,000 and validates every key', async () => {
    const calls: (string | string[])[] = [];
    const bucket = { delete: async (k: string | string[]) => { calls.push(k); } } as unknown as R2BucketLike;
    const store = createR2BlobStore(bucket);
    const keys = Array.from({ length: 2_345 }, (_, i) => `org/o/packets/p${i}/x.pdf`);
    await store.deleteMany!(keys);
    expect(R2_DELETE_BATCH).toBe(1_000);
    expect(calls.map((c) => (c as string[]).length)).toEqual([1_000, 1_000, 345]);
    expect(calls.flat()).toEqual(keys);
    await expect(store.deleteMany!(['ok/key', '../escape'])).rejects.toThrow();
    expect(calls).toHaveLength(3); // nothing deleted when a key is unsafe
  });
});
