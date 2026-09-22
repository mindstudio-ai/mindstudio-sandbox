/**
 * The root logger (`src/logger.ts`), pointed at stderr.
 *
 * STDOUT IS THE PROTOCOL CHANNEL in this process — every line of it is parsed by
 * the C&C (`ipc/ipc.ts`), so a log line there corrupts the stream. The root
 * logger's default sink is stdout, which is right for the C&C and wrong here.
 *
 * The redirect happens at module evaluation, on purpose. Every module under
 * `devTunnel/` imports the logger through this file, so the sink is swapped
 * before any of them can make a call — the guarantee is structural, not an
 * init-ordering convention someone has to remember. (This module used to be a
 * second logger with a different call shape that discarded everything until an
 * explicit init; one logger with one sink replaced it.)
 *
 * The levels are set from the environment in `session.ts`. Until then the root
 * defaults apply: `info`, which is also this process's documented default.
 *
 * @module
 */

import { setLogSink } from '../../logger.ts';

setLogSink((line) => {
  process.stderr.write(line + '\n');
});

export {
  createLogger,
  parseLogLevel,
  setLogLevel,
  setSinkLogLevel,
  type LogLevel,
} from '../../logger.ts';
