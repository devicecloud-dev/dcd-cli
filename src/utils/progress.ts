/**
 * Progress adapter that wraps @clack/prompts spinner with a
 * drop-in API for existing services that used oclif's `ux.action` / `ux.info`.
 *
 * Keeps call sites unchanged while migrating away from @oclif/core.
 *
 * TTY-awareness: @clack/prompts' spinner animates on a timer and, when stdout
 * isn't a TTY (CI, pipes, redirects), it can't rewrite a line in place — every
 * frame becomes a fresh line, flooding logs with hundreds of duplicates. In
 * non-interactive environments we skip the spinner entirely and instead print a
 * plain line once per *distinct* status, so CI logs show real progress without
 * the flood.
 *
 * Styling: the spinner uses the CLI's own palette (cyan braille frames) rather
 * than clack's magenta default, and no `│` guide bar, since the rest of the CLI
 * is a `⏺`/`⎿` tree rather than a clack session. The final line is written by
 * us, not clack, so it carries the same `✓` / `✗` symbols as every other
 * command (see STYLE_GUIDE.md).
 */
import * as p from '@clack/prompts';

import { isCI } from './ci.js';
import { colors, symbols } from './styling.js';

type ClackSpinner = ReturnType<typeof p.spinner>;

// Braille dots where the terminal can draw them, plain ASCII otherwise.
const FRAMES = p.unicode
  ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  : ['-', '\\', '|', '/'];

class Action {
  private current: ClackSpinner | null = null;
  private _status = '';
  // Last line emitted in non-interactive mode, for de-duplication.
  private _lastPrinted = '';

  private interactive(): boolean {
    return process.stdout.isTTY === true && !isCI();
  }

  start(title: string, initialStatus?: string, _opts?: unknown): void {
    this._status = initialStatus ?? '';
    const line = initialStatus ? `${title} ${colors.dim('·')} ${initialStatus}` : title;
    if (!this.interactive()) {
      this.current = null;
      this.print(line);
      return;
    }
    if (this.current) {
      this.current.clear();
    }
    this.current = p.spinner({
      delay: 80,
      frames: FRAMES,
      styleFrame: colors.highlight,
      withGuide: false,
    });
    this.current.start(line);
  }

  /** End the action as a success: `✓ message`. */
  stop(message?: string): void {
    this.finish(symbols.success, message);
  }

  /** End the action as a failure: `✗ message`. */
  fail(message?: string): void {
    this.finish(symbols.error, message);
  }

  set status(value: string) {
    this._status = value;
    if (!value) return;
    if (!this.interactive()) {
      this.print(value);
      return;
    }
    if (this.current) {
      this.current.message(value);
    }
  }

  get status(): string {
    return this._status;
  }

  // Erase the spinner (if one is live) and print the final line ourselves, so
  // the symbol matches the rest of the CLI instead of clack's `◇`.
  private finish(symbol: string, message?: string): void {
    const line = message ? `${symbol} ${message}` : '';
    if (!this.interactive()) {
      if (line) this.print(line);
      this.current = null;
      this._status = '';
      this._lastPrinted = '';
      return;
    }
    this.current?.clear();
    this.current = null;
    this._status = '';
    if (line) {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  // Emit a line only when it differs from the previous one, so repeated polls
  // with no state change stay quiet.
  private print(line: string): void {
    if (line === this._lastPrinted) return;
    this._lastPrinted = line;
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export const ux = {
  action: new Action(),
  info(message: string): void {
    // eslint-disable-next-line no-console
    console.log(message);
  },
};
