/**
 * The local files an MCP tool may read or write for the agent: only inside
 * the working directory the server was started in (the agent's project), and
 * a write never replaces a file this server did not write. An agent's tool
 * call is not the user typing a path: without these limits a tool could
 * send `~/.aws/credentials` as a flow, or write a report over `~/.zshrc`.
 * Symbolic links are followed before the check, so a link can't lead out.
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

/** The working directory, as the file system names it (symbolic links resolved). */
export function workingDirectory(): string {
  return realpathSync(process.cwd());
}

/** Whether `child` is `parent` or inside it. Both absolute and resolved. */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function outside(given: string, root: string): Error {
  return new Error(
    `${given} is outside the working directory (${root}). This server reads and writes files only there: start it in the folder that holds them, or copy them in.`,
  );
}

/** An existing file or folder the agent named, resolved, inside the working directory. */
export function localInput(given: string, root: string = workingDirectory()): string {
  let real: string;
  try {
    real = realpathSync(path.resolve(root, given));
  } catch {
    throw new Error(`No such file or directory: ${given}`);
  }

  if (!isInside(real, root)) throw outside(given, root);
  return real;
}

/** Files this server wrote, which it may write again. */
const written = new Set<string>();

/**
 * Where to write a file the agent asked for, resolved: inside the working
 * directory, and not over a file this server did not write. Folders that do
 * not exist yet are allowed; the writer makes them.
 */
export function localOutput(given: string, root: string = workingDirectory()): string {
  const absolute = path.resolve(root, given);
  // The deepest folder that exists, resolved; the rest is appended to it.
  let existing = path.dirname(absolute);
  const rest = [path.basename(absolute)];
  while (!existsSync(existing)) {
    rest.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }

  const target = path.join(realpathSync(existing), ...rest);
  if (!isInside(target, root) || target === root) throw outside(given, root);
  // lstat, not exists: a dangling symbolic link is a file there too.
  let present: boolean;
  try {
    lstatSync(target);
    present = true;
  } catch {
    present = false;
  }

  if (present && !written.has(target)) {
    throw new Error(`${given} already exists, and this server did not write it. Pass a new path, or remove the file first.`);
  }

  return target;
}

/** Record a file this server wrote, so a later call may write it again. */
export function markWritten(file: string): void {
  written.add(file);
}
