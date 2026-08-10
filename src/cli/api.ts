/**
 * The authed HTTP client for the MindStudio internal API.
 *
 * Three entry points, because the commands need three different failure shapes:
 * `api` throws on a bad status (most commands), `apiTry` returns the status so a
 * caller can tolerate one (`releases wait` polls through 404s), and `apiStream`
 * reads SSE (`methods invoke --stream`).
 */

import { API_BASE, API_KEY } from './config.js';
import { fatal } from './errors.js';
import { out } from './output.js';

/** Bound one request, so a hung API call can't hang the CLI indefinitely. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** The raw Lighthouse report is a large artifact pulled from object storage. */
export const REPORT_TIMEOUT_MS = 60_000;
/** A stream may legitimately run for minutes; bound idle time between chunks. */
const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Percent-encode one URL path segment. */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Read a response body without assuming it is JSON.
 *
 * A 204 or an empty body is a legitimate success for the DELETE endpoints
 * (`secrets delete`, `users revoke-api-key`). res.json() throws on those, which
 * turned a successful mutation into a reported failure.
 */
async function readBody(res: Response): Promise<any> {
  if (res.status === 204) {
    return { ok: true, status: 204 };
  }
  const text = await res.text().catch(() => '');
  if (!text.trim()) {
    return { ok: true, status: res.status };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError') {
      fatal(`${label} timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
}

export async function api(
  method: string,
  apiPath: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const res = await fetchWithTimeout(
    `${API_BASE}${apiPath}`,
    {
      method,
      headers: authHeaders(),
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    REQUEST_TIMEOUT_MS,
    `API ${method} ${apiPath}`,
  );

  if (!res.ok) {
    fatal(
      `API ${method} ${apiPath} returned ${res.status}: ${JSON.stringify(await readBody(res))}`,
    );
  }

  return readBody(res);
}

/**
 * Like `api`, but never throws on an HTTP status — returns a structured result
 * so a caller can react to one (e.g. tolerate a 404 while a release row is still
 * being created after a push).
 */
export async function apiTry(
  method: string,
  apiPath: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetchWithTimeout(
    `${API_BASE}${apiPath}`,
    { method, headers: authHeaders() },
    REQUEST_TIMEOUT_MS,
    `API ${method} ${apiPath}`,
  );
  return { ok: res.ok, status: res.status, body: await readBody(res) };
}

export async function apiStream(
  apiPath: string,
  body: Record<string, unknown>,
): Promise<void> {
  // Idle timeout, not a total deadline: a long-running method is legitimate,
  // a stream that stops producing is not.
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idled = false;
  const armIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      idled = true;
      controller.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  try {
    armIdleTimer();
    const res = await fetch(`${API_BASE}${apiPath}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      fatal(
        `API POST ${apiPath} returned ${res.status}: ${JSON.stringify(await readBody(res))}`,
      );
    }

    if (!res.body) {
      fatal('Stream response has no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const emit = (line: string) => {
      if (!line.startsWith('data: ')) {
        return;
      }
      try {
        out(JSON.parse(line.slice(6)));
      } catch {
        // skip unparseable SSE lines
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush the tail: a final event with no trailing newline is still an
        // event, and it is usually the terminal one.
        emit(buffer);
        break;
      }
      armIdleTimer();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        emit(line);
      }
    }
  } catch (err: any) {
    if (idled || err?.name === 'AbortError') {
      fatal(
        `Stream POST ${apiPath} stalled — no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`,
      );
    }
    throw err;
  } finally {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
  }
}
