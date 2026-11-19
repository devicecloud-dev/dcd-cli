import type { ArgsDef, CommandContext, CommandDef } from 'citty';

import { CliError } from './cli.js';
import { DEVICE_EXIT, runDeviceCommand } from './device-output.js';

/*
 * citty accepts any flag and ignores the ones a command does not define. For
 * `dcd device` that is unsafe: `type --text hunter2 --sensetive` typed a
 * password in plain text and exited 0, and `--wiat` started a session
 * without waiting. So every `dcd device` subcommand refuses a flag it does
 * not know, and suggests the one that was meant.
 */

const camel = (name: string): string => name.replaceAll(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const kebab = (name: string): string =>
  name.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();

interface FlagSpec {
  /** Every spelling that sets it: its name, citty's camel and kebab forms, its aliases. */
  names: Set<string>;
  /** Its name as the help shows it. */
  primary: string;
  /** It takes a value, so the token after `--flag` is that value. */
  takesValue: boolean;
}

function flagSpecs(args: ArgsDef): FlagSpec[] {
  return Object.entries(args)
    .filter(([, def]) => def.type !== 'positional')
    .map(([name, def]) => {
      const alias = (def as { alias?: string | string[] }).alias;
      const aliases = Array.isArray(alias) ? alias : alias ? [alias] : [];
      const names = new Set<string>();
      for (const n of [name, ...aliases]) {
        names.add(n);
        names.add(camel(n));
        names.add(kebab(n));
      }

      return { names, primary: name, takesValue: def.type === 'string' || def.type === 'enum' };
    });
}

/** The edit distance between two words, a swap of neighbours counting as one edit. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[a.length][b.length];
}

/** Words other tools use for a flag of ours. */
const SYNONYMS: Record<string, string> = { secret: 'sensitive', secure: 'sensitive' };

/** Flags people carry over from `dcd live` and the MCP tools, for the session id. */
const SESSION_FLAGS = new Set(['id', 'session', 'session-id', 'sessionId', 'session_id']);

/** What to say about one unknown flag: the flag meant, when it is clear. */
function hint(given: string, specs: FlagSpec[], positionals: string[]): string {
  const bare = given.replace(/^-+/, '').replace(/=.*$/, '');
  if (SESSION_FLAGS.has(bare) && positionals.includes('id')) {
    return ' The session id is an argument, not a flag: `dcd device <command> <id>`.';
  }

  const negated = bare.startsWith('no-');
  const base = kebab(negated ? bare.slice(3) : bare);
  const synonym = SYNONYMS[base];
  if (synonym && specs.some((s) => s.primary === synonym)) return ` Did you mean --${negated ? 'no-' : ''}${synonym}?`;
  let best: { distance: number; name: string } | null = null;
  for (const spec of specs) {
    const distance = editDistance(base, spec.primary);
    if (!best || distance < best.distance) best = { distance, name: spec.primary };
  }

  // Close enough to be a slip of the keys, not another word.
  if (best && best.distance <= 2 && best.distance < base.length / 2) {
    return ` Did you mean --${negated ? 'no-' : ''}${best.name}?`;
  }

  return '';
}

/**
 * The flags in `rawArgs` that `args` does not define, each as typed. A
 * value after a flag that takes one is skipped, so `--yaml "- launchApp"`
 * and `--longitude -0.1278` are read as values. `--` ends the flags.
 */
export function unknownFlags(rawArgs: string[], args: ArgsDef): string[] {
  const specs = flagSpecs(args);
  const find = (name: string) => specs.find((s) => s.names.has(name) || s.names.has(camel(name)));
  const unknown: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === '--') break;
    if (!token.startsWith('-') || token === '-' || /^-\d/.test(token)) continue;
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token : token.slice(0, eq)).replace(/^-{1,2}/, '');
    if (token.startsWith('--')) {
      const spec = find(name) ?? (name.startsWith('no-') ? find(name.slice(3)) : undefined);
      if (!spec) unknown.push(token.slice(0, eq === -1 ? undefined : eq));
      else if (spec.takesValue && eq === -1 && !name.startsWith('no-')) i++;
      continue;
    }

    // Short flags, e.g. -o file or -f: each letter must be one of ours, and
    // one that takes a value ends the group (its value is the rest, or the
    // next token).
    for (let k = 0; k < name.length; k++) {
      const spec = find(name[k]);
      if (!spec) {
        unknown.push(`-${name[k]}`);
        break;
      }

      if (spec.takesValue) {
        if (k === name.length - 1 && eq === -1) i++;
        break;
      }
    }
  }

  return unknown;
}

/** The usage error for unknown flags, or null when there are none. */
export function unknownFlagsError(rawArgs: string[], args: ArgsDef): CliError | null {
  const unknown = unknownFlags(rawArgs, args);
  if (unknown.length === 0) return null;
  const specs = flagSpecs(args);
  const positionals = Object.entries(args)
    .filter(([, def]) => def.type === 'positional')
    .map(([name]) => name);
  const lines = unknown.map((flag) => `Unknown flag ${flag}.${hint(flag, specs, positionals)}`);
  return new CliError(`${lines.join(' ')} See --help for the flags this command takes.`, DEVICE_EXIT.usage);
}

/**
 * A `dcd device` subcommand that refuses unknown flags before it runs: with
 * --json the refusal is the usual envelope, exit 1.
 */
export function strictFlags<T extends ArgsDef>(sub: CommandDef<T>): CommandDef<T> {
  const { run } = sub;
  if (!run) return sub;
  return {
    ...sub,
    async run(context: CommandContext<T>) {
      const args = (sub.args ?? {}) as ArgsDef;
      const problem = unknownFlagsError(context.rawArgs ?? [], args);
      if (problem) {
        await runDeviceCommand(Boolean((context.args as Record<string, unknown>).json), async () => {
          throw problem;
        });
        return;
      }

      return run(context);
    },
  };
}
