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
 */
import * as p from '@clack/prompts';

import { isCI } from './ci.js';

type ClackSpinner = ReturnType<typeof p.spinner>;

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
    const line = initialStatus ? `${title} — ${initialStatus}` : title;
    if (!this.interactive()) {
      this.current = null;
      this.print(line);
      return;
    }
    if (this.current) {
      this.current.stop();
    }
    this.current = p.spinner();
    this.current.start(line);
  }

  stop(message?: string): void {
    if (!this.interactive()) {
      if (message) this.print(message);
      this.current = null;
      this._status = '';
      this._lastPrinted = '';
      return;
    }
    if (!this.current) {
      if (message) {
        // eslint-disable-next-line no-console
        console.log(message);
      }
      return;
    }
    this.current.stop(message ?? '');
    this.current = null;
    this._status = '';
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
