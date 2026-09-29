import type { ArgDef, ArgsDef, CommandDef } from 'citty';

/**
 * A citty arg definition plus a local `hidden` marker. citty (0.2) can hide a
 * command from help (`meta.hidden`) but not an arg, so {@link withoutHiddenArgs}
 * drops hidden args before usage is rendered. They still parse as normal.
 */
export type CliArgDef = ArgDef & { hidden?: boolean };
export type CliArgsDef = Record<string, CliArgDef>;

/** `cmd` with its hidden args left out, for rendering `--help` only. */
export async function withoutHiddenArgs<T extends ArgsDef>(
  cmd: CommandDef<T>,
): Promise<CommandDef<T>> {
  const args = typeof cmd.args === 'function' ? await cmd.args() : await cmd.args;
  if (!args) return cmd;

  const visible = Object.fromEntries(
    Object.entries(args).filter(([, def]) => !(def as CliArgDef).hidden),
  ) as T;
  return { ...cmd, args: visible };
}
