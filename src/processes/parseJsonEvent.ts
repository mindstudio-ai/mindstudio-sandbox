/** Parse a newline-delimited JSON event from a child process stdout line. */
export function parseJsonEvent<T>(line: string): T | null {
  try {
    const parsed = JSON.parse(line);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.event === 'string'
    ) {
      return parsed as T;
    }
    return null;
  } catch {
    return null;
  }
}
