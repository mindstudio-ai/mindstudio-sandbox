/**
 * Presigned-POST upload — bytes go straight to storage, never through the API,
 * so size isn't bounded by the API's JSON body limit. Shared by `files put`
 * and `datasources add`; the server mints `{ uploadUrl, uploadFields }` scoped
 * to one key, and this submits the multipart form (no auth headers — the
 * signature is in the fields).
 */

import { fatal } from './errors.js';

export async function uploadDirect(
  upload: { uploadUrl: string; uploadFields: Record<string, string> },
  bytes: Buffer,
  filename: string,
): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(upload.uploadFields)) {
    form.append(key, value);
  }
  // Zero-copy view (a pooled Buffer can sit at an offset in a larger
  // ArrayBuffer, so slice by view — matters for the 100MB+ uploads this
  // path exists for). The cast is safe: fs reads never yield SharedArrayBuffer.
  const view = new Uint8Array(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  form.append('file', new Blob([view]), filename);

  const res = await fetch(upload.uploadUrl, { method: 'POST', body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    fatal(
      `Upload of "${filename}" failed: ${res.status} ${res.statusText}${
        detail ? ` — ${detail.slice(0, 300)}` : ''
      }`,
    );
  }
}
