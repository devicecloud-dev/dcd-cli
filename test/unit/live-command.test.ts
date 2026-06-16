import { expect } from 'chai';

import { liveCommand } from '../../src/commands/live';

/**
 * Regression coverage for #15: citty invokes a parent command's `run` *after*
 * dispatching to a subcommand, so `liveCommand.run` must suppress the
 * "Live Session Commands" menu when a subcommand was matched — otherwise the
 * menu prints after every `dcd live start|status|install|exec|stop`.
 */
describe('live command menu', () => {
  function captureMenu(rawArgs: string[]): boolean {
    let out = '';
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      (liveCommand.run as (ctx: { rawArgs: string[] }) => void)({ rawArgs });
    } finally {
      process.stdout.write = original;
    }
    return out.includes('Live Session Commands');
  }

  it('prints the menu when invoked with no subcommand', () => {
    expect(captureMenu([])).to.equal(true);
  });

  it('does NOT print the menu when a subcommand is matched', () => {
    for (const sub of ['start', 'install', 'exec', 'stop', 'status']) {
      expect(captureMenu([sub]), `subcommand ${sub} should not leak the menu`).to.equal(
        false,
      );
    }
  });

  it('still prints the menu when the first positional is not a subcommand', () => {
    // citty would reject this as an unknown command before reaching run(), but
    // the menu is the correct fallback if run() is ever reached directly.
    expect(captureMenu(['bogus'])).to.equal(true);
  });
});
