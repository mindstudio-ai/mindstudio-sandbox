/**
 * Spec-driven argument parsing for mindstudio-prod, over node:util parseArgs.
 *
 * The point of declaring a spec per command isn't tidiness — it's that a parser
 * which knows the valid flags can REJECT the ones it doesn't know. The previous
 * hand-rolled helpers couldn't: `--lmit 10` was silently dropped and the command
 * ran with defaults, which for an agent-driven CLI is the worst failure mode
 * there is. Everything else here (correct boolean arity, `--flag=value`, numeric
 * validation, required-positional checks) falls out of the same table.
 *
 * All validation is eager, so a handler can never observe bad input.
 */

import { parseArgs } from 'node:util';
import { UsageError } from './errors.js';

export interface FlagSpec {
  /**
   * parseArgs only knows 'boolean' | 'string'; 'number' is a 'string' to it,
   * plus integer coercion + range validation on our side.
   */
  type: 'boolean' | 'string' | 'number';
  /**
   * When set, this flag maps 1:1 onto an API query param and is picked up by
   * `Args.query()`. Declaration order determines query-string order, so keep it
   * matching whatever the endpoint saw before.
   */
  param?: string;
  /** 'number' only. Use 0 to forbid negatives. */
  min?: number;
  /** 'number' only. */
  max?: number;
}

export interface PositionalSpec {
  name: string;
  required?: boolean;
  /** Must be declared last. Collects the remainder; read via `Args.rest()`. */
  variadic?: boolean;
  choices?: readonly string[];
  /** Prefix for an invalid choice, e.g. 'Unknown dimension'. */
  choiceLabel?: string;
}

export interface CommandSpec {
  /** Verbatim usage string, printed on any input error. */
  usage: string;
  positionals?: readonly PositionalSpec[];
  flags?: Readonly<Record<string, FlagSpec>>;
  /**
   * Skip flag parsing entirely — every token is a positional. Exists for `db`,
   * whose SQL may legally begin with a `--` comment and would otherwise be
   * rejected as an unknown option. This is the one deliberate hole in the
   * strict-unknown-flag guarantee.
   */
  raw?: true;
  /** At least one of these must be present, else `message` is the error. */
  requireAnyOf?: {
    flags?: readonly string[];
    positionals?: readonly string[];
    message: string;
  };
}

/**
 * Flag groups shared by more than one command group. Declaration order matters:
 * `Args.query()` iterates it, so the emitted query string follows this order.
 */
export const WINDOW = {
  start: { type: 'string', param: 'start' },
  end: { type: 'string', param: 'end' },
} as const satisfies Record<string, FlagSpec>;

export const PAGINATION = {
  limit: { type: 'number', param: 'limit', min: 0 },
  offset: { type: 'number', param: 'offset', min: 0 },
} as const satisfies Record<string, FlagSpec>;

type FlagValue = string | number | boolean | undefined;

export class Args {
  constructor(
    private readonly spec: CommandSpec,
    private readonly positionals: string[],
    private readonly flags: Record<string, FlagValue>,
  ) {}

  /** A required positional. Presence was validated at parse time. */
  req(name: string): string {
    const value = this.positionals[this.indexOf(name)];
    if (value === undefined) {
      // Unreachable via parseCommand — guards against a spec that forgot
      // `required: true` on a positional the handler treats as mandatory.
      throw new UsageError(`Missing required argument <${name}>.`, this.usage);
    }
    return value;
  }

  /** An optional positional. */
  opt(name: string): string | undefined {
    return this.positionals[this.indexOf(name)];
  }

  /** The variadic tail. */
  rest(name: string): string[] {
    return this.positionals.slice(this.indexOf(name));
  }

  str(flag: string): string | undefined {
    const value = this.flags[flag];
    return value === undefined ? undefined : String(value);
  }

  num(flag: string): number | undefined {
    const value = this.flags[flag];
    return value === undefined ? undefined : Number(value);
  }

  bool(flag: string): boolean {
    return this.flags[flag] === true;
  }

  has(flag: string): boolean {
    return this.flags[flag] !== undefined;
  }

  /**
   * Query string ('' or '?a=1&b=2') built from every present flag that declares
   * a `param`, in spec declaration order.
   */
  query(): string {
    return this.queryWith({});
  }

  /**
   * Like `query()`, with extra params appended after the spec-declared ones —
   * for the handful of commands that promote a positional into a query param
   * (e.g. `analytics events <name>`). Undefined values are skipped.
   */
  queryWith(extra: Record<string, string | undefined>): string {
    const params = new URLSearchParams();
    for (const [flag, flagSpec] of Object.entries(this.spec.flags ?? {})) {
      if (!flagSpec.param) {
        continue;
      }
      const value = this.flags[flag];
      if (value === undefined || value === false) {
        continue;
      }
      params.set(flagSpec.param, String(value));
    }
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        params.set(key, value);
      }
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }

  get usage(): string {
    return this.spec.usage;
  }

  private indexOf(name: string): number {
    const index = (this.spec.positionals ?? []).findIndex(
      (p) => p.name === name,
    );
    if (index === -1) {
      throw new Error(
        `Spec bug: no positional named "${name}" in "${this.spec.usage}"`,
      );
    }
    return index;
  }
}

/**
 * Reject undeclared flags with a message that names the valid ones.
 *
 * parseArgs' own strict error is good but generic; since remy self-corrects from
 * error text, listing the real options turns a failed call into a usable hint.
 * `strict: true` still backs this up.
 */
function preflightUnknownFlags(argv: string[], spec: CommandSpec): void {
  const declared = new Set(Object.keys(spec.flags ?? {}));
  for (const token of argv) {
    if (token === '--') {
      break; // everything after the terminator is positional
    }
    if (!token.startsWith('--') || token.length === 2) {
      continue;
    }
    const name = token.slice(2).split('=', 1)[0];
    if (declared.has(name)) {
      continue;
    }
    const valid = declared.size
      ? `Valid options: ${[...declared].map((f) => `--${f}`).join(', ')}.`
      : 'This command takes no options.';
    throw new UsageError(`Unknown option '--${name}'. ${valid}`, spec.usage);
  }
}

function coerceNumber(
  raw: string,
  flag: string,
  flagSpec: FlagSpec,
  usage: string,
): number {
  const value = Number(raw);
  // Number('') === 0 and Number(' ') === 0, so check the text too. Integer-only:
  // every numeric flag here is a count, an offset, or a whole number of seconds.
  if (raw.trim() === '' || !Number.isInteger(value)) {
    throw new UsageError(`--${flag} must be an integer (got "${raw}").`, usage);
  }
  if (flagSpec.min !== undefined && value < flagSpec.min) {
    throw new UsageError(`--${flag} must be >= ${flagSpec.min}.`, usage);
  }
  if (flagSpec.max !== undefined && value > flagSpec.max) {
    throw new UsageError(`--${flag} must be <= ${flagSpec.max}.`, usage);
  }
  return value;
}

function bindPositionals(found: string[], spec: CommandSpec): string[] {
  const declared = spec.positionals ?? [];

  for (const [index, positional] of declared.entries()) {
    const value = found[index];
    if (value === undefined) {
      if (positional.required) {
        throw new UsageError(
          `Missing required argument <${positional.name}>.`,
          spec.usage,
        );
      }
      continue;
    }
    if (positional.choices && !positional.choices.includes(value)) {
      const label = positional.choiceLabel ?? `Unknown ${positional.name}`;
      throw new UsageError(
        `${label} "${value}". Valid: ${positional.choices.join('|')}`,
        spec.usage,
      );
    }
  }

  const last = declared[declared.length - 1];
  if (!last?.variadic && found.length > declared.length) {
    throw new UsageError(
      `Unexpected extra argument "${found[declared.length]}".`,
      spec.usage,
    );
  }

  return found;
}

function checkRequireAnyOf(
  spec: CommandSpec,
  positionals: string[],
  flags: Record<string, FlagValue>,
): void {
  const rule = spec.requireAnyOf;
  if (!rule) {
    return;
  }
  const hasFlag = (rule.flags ?? []).some((f) => flags[f] !== undefined);
  const hasPositional = (rule.positionals ?? []).some((name) => {
    const index = (spec.positionals ?? []).findIndex((p) => p.name === name);
    return index !== -1 && positionals[index] !== undefined;
  });
  if (!hasFlag && !hasPositional) {
    throw new UsageError(rule.message, spec.usage);
  }
}

/** Parse one command invocation. Throws UsageError on any bad input. */
export function parseCommand(spec: CommandSpec, argv: string[]): Args {
  if (spec.raw) {
    // No flag parsing at all: the tokens are the payload.
    const positionals = bindPositionals([...argv], spec);
    return new Args(spec, positionals, {});
  }

  preflightUnknownFlags(argv, spec);

  const options: Record<string, { type: 'boolean' | 'string' }> = {};
  for (const [flag, flagSpec] of Object.entries(spec.flags ?? {})) {
    options[flag] = {
      type: flagSpec.type === 'boolean' ? 'boolean' : 'string',
    };
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (err: any) {
    // parseArgs' messages are already precise — including the hint to use
    // `--flag=-value` for a value starting with a dash. Just append usage.
    throw new UsageError(err.message, spec.usage);
  }

  const flags: Record<string, FlagValue> = {};
  for (const [flag, flagSpec] of Object.entries(spec.flags ?? {})) {
    const raw = parsed.values[flag];
    if (raw === undefined) {
      continue;
    }
    flags[flag] =
      flagSpec.type === 'number'
        ? coerceNumber(String(raw), flag, flagSpec, spec.usage)
        : (raw as FlagValue);
  }

  const positionals = bindPositionals(parsed.positionals, spec);
  checkRequireAnyOf(spec, positionals, flags);
  return new Args(spec, positionals, flags);
}
