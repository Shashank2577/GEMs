import type { BlobBody } from '../deps';

/** Normalise any accepted blob body to bytes. */
export async function toBytes(body: BlobBody): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await body.arrayBuffer());
}

/** Reject keys that could escape the store root. */
export function assertSafeKey(key: string): void {
  if (!key || key.length > 1024 || key.startsWith('/') || key.includes('\\') || key.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    throw new Error(`Invalid blob key: ${JSON.stringify(key)}`);
  }
}

export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(ctrl) { ctrl.enqueue(bytes); ctrl.close(); } });
}

export function guessContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    json: 'application/json', txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', csv: 'text/csv',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}
