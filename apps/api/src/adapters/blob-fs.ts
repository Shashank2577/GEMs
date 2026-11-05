/** Filesystem BlobStore for local dev / CI (Node only). Metadata lives in a `<file>.meta.json` sidecar. */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { BlobBody, BlobMeta, BlobObject, BlobStore } from '../deps';
import { assertSafeKey, bytesToStream, guessContentType, toBytes } from './blob-common';

export function createFsBlobStore(rootDir: string): BlobStore {
  const root = resolve(rootDir);
  const pathFor = (key: string) => {
    assertSafeKey(key);
    const p = resolve(join(root, key));
    if (!p.startsWith(root + '/')) throw new Error('Invalid blob key');
    return p;
  };
  const readMeta = async (key: string): Promise<BlobMeta | null> => {
    const p = pathFor(key);
    try {
      const st = await stat(p);
      let contentType = guessContentType(key);
      try { contentType = JSON.parse(await readFile(`${p}.meta.json`, 'utf8')).contentType ?? contentType; } catch { /* no sidecar */ }
      return { key, size: st.size, contentType, uploadedAt: st.mtime };
    } catch { return null; }
  };

  return {
    async put(key: string, body: BlobBody, opts?: { contentType?: string }) {
      const p = pathFor(key);
      const bytes = await toBytes(body);
      const contentType = opts?.contentType ?? guessContentType(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
      await writeFile(`${p}.meta.json`, JSON.stringify({ contentType }));
      return { key, size: bytes.byteLength, contentType, uploadedAt: new Date() };
    },
    async get(key: string): Promise<BlobObject | null> {
      const meta = await readMeta(key);
      if (!meta) return null;
      const bytes = new Uint8Array(await readFile(pathFor(key)));
      return {
        ...meta,
        body: bytesToStream(bytes),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      };
    },
    head: readMeta,
    async delete(key: string) {
      const p = pathFor(key);
      await rm(p, { force: true });
      await rm(`${p}.meta.json`, { force: true });
    },
  };
}
