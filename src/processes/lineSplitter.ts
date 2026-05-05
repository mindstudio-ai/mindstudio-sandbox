/**
 * Stream → newline-delimited line splitter.
 *
 * Splits an incoming UTF-8 stream on `\n` (with optional preceding `\r`)
 * ONLY. Critically, it does NOT treat U+2028 (LINE SEPARATOR) or U+2029
 * (PARAGRAPH SEPARATOR) as line terminators.
 *
 * Why we don't use Node's built-in `readline.createInterface`: readline's
 * line-splitting regex includes ` ` and ` `, and that behavior
 * is not configurable. Both characters are valid inside JSON string
 * contents, and `JSON.stringify` in V8 leaves them unescaped. A user
 * pasting from Apple Notes (or any source that includes U+2028) into
 * agent chat ends up with the JSON history payload getting shredded
 * across multiple readline 'line' events that all silently fail
 * `JSON.parse`. This splitter is the authoritative line reader for any
 * NDJSON-over-pipe protocol in the sandbox.
 */

import type { Readable } from 'node:stream';

/**
 * Attach a line handler to a stream. The callback is invoked once per
 * `\n`-terminated line, plus once for any trailing buffer on stream end.
 * Lines do not include the terminator.
 */
export function attachLineHandler(
  stream: Readable,
  onLine: (line: string) => void,
): void {
  let buffer = '';
  stream.setEncoding('utf-8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let nlIdx: number;
    while ((nlIdx = buffer.indexOf('\n')) !== -1) {
      const endIdx =
        nlIdx > 0 && buffer[nlIdx - 1] === '\r' ? nlIdx - 1 : nlIdx;
      const line = buffer.slice(0, endIdx);
      buffer = buffer.slice(nlIdx + 1);
      onLine(line);
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) {
      onLine(buffer);
      buffer = '';
    }
  });
}
