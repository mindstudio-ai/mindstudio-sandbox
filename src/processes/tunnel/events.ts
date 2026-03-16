export interface TunnelEvent {
  event: string;
  [key: string]: unknown;
}

export function parseTunnelLine(line: string): TunnelEvent | null {
  try {
    const parsed = JSON.parse(line);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.event === 'string'
    ) {
      return parsed as TunnelEvent;
    }
    return null;
  } catch {
    return null;
  }
}
