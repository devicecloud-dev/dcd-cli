/**
 * Progress adapter that wraps @clack/prompts spinner with a
 * drop-in API for existing services that used oclif's `ux.action` / `ux.info`.
 *
 * Keeps call sites unchanged while migrating away from @oclif/core.
 */
import * as p from '@clack/prompts';

type ClackSpinner = ReturnType<typeof p.spinner>;

class Action {
  private current: ClackSpinner | null = null;
  private _status = '';

  start(title: string, initialStatus?: string, _opts?: unknown): void {
    if (this.current) {
      this.current.stop();
    }
    this.current = p.spinner();
    this._status = initialStatus ?? '';
    this.current.start(initialStatus ? `${title} — ${initialStatus}` : title);
  }

  stop(message?: string): void {
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
    if (this.current && value) {
      this.current.message(value);
    }
  }

  get status(): string {
    return this._status;
  }
}

export const ux = {
  action: new Action(),
  info(message: string): void {
    // eslint-disable-next-line no-console
    console.log(message);
  },
};
