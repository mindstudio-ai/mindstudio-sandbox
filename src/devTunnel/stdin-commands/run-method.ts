import { detectAppConfigUntil } from '../config/app-config.ts';
import { CommandError } from './types.ts';
import type { CommandContext } from './types.ts';
import type { TunnelCommandResult } from '../protocol.ts';

export async function handleRunMethod(
  ctx: CommandContext,
  cmd: Record<string, unknown>,
): Promise<TunnelCommandResult['run-method']> {
  if (!ctx.state.runner) {
    throw new CommandError('No active session', 'NO_SESSION');
  }

  const methodName = cmd.method as string;
  if (!methodName) {
    throw new CommandError(
      'run-method requires "method" (export name or ID)',
      'INVALID_INPUT',
    );
  }

  // Retry-aware manifest read so freshly-added methods are picked up even
  // when the call lands inside the brief window between the user's
  // mindstudio.json write and the file watcher's debounce firing.
  const freshConfig =
    (await detectAppConfigUntil(ctx.cwd, (c) =>
      c.methods.some((m) => m.export === methodName || m.id === methodName),
    )) ?? ctx.state.appConfig;
  const method =
    freshConfig?.methods.find((m) => m.export === methodName) ??
    freshConfig?.methods.find((m) => m.id === methodName);
  if (!method) {
    throw new CommandError(`Unknown method: ${methodName}`, 'INVALID_INPUT');
  }

  ctx.started({ method: method.export });

  const result = await ctx.state.runner.runMethod({
    methodExport: method.export,
    methodPath: method.path,
    input: cmd.input ?? {},
    roles: Array.isArray(cmd.roles) ? (cmd.roles as string[]) : undefined,
    userId: typeof cmd.userId === 'string' ? cmd.userId : undefined,
    // The roles branch keys on auth.enabled, so it needs the same freshness
    // the method lookup above does.
    appConfig: freshConfig,
  });

  return {
    success: result.success,
    method: method.export,
    output: result.output ?? null,
    // The worker's error is an untyped `Record<string, unknown>` (it carries
    // whatever the method threw — stack, code, statusCode, cause), so
    // `.message` is not known to be a string. Every consumer of this field
    // treats it as one, so make that true here rather than leaving the
    // guarantee to luck. The whole object still rides along as `errorDetail`.
    error:
      typeof result.error?.message === 'string' ? result.error.message : null,
    errorCode: result.success ? undefined : 'EXECUTION_ERROR',
    errorDetail: result.error ?? null,
    stdout: result.stdout ?? [],
    duration: result.duration,
  };
}
