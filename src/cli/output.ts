/**
 * The CLI's output contract, both halves in one place:
 * results and errors go to stdout as JSON, human progress goes to stderr.
 *
 * That split is what lets a caller pipe stdout straight into a JSON parser
 * while a person watching a long poll still sees something happen.
 */

/**
 * Compact JSON for machine callers, indented for a human at a terminal. remy
 * always reads this through a pipe, so it gets one JSON value per line — which
 * is what makes `--stream` output parseable line by line.
 */
const PRETTY = process.stdout.isTTY === true;

export function out(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, PRETTY ? 2 : 0)}\n`);
}

/** Progress to stderr so stdout stays a clean stream of JSON values. */
export function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}
