import { expect } from 'chai';

import { liveCommand } from '../../src/commands/live.js';

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

describe('live command deprecation', () => {
  it('is hidden from help', () => {
    expect((liveCommand.meta as { hidden?: boolean }).hidden).to.equal(true);
  });

  it('prints the deprecation on stderr, never stdout', () => {
    let err = '';
    let out = '';
    const writeErr = process.stderr.write.bind(process.stderr);
    const writeOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: string) => {
      err += chunk;
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      (liveCommand.setup as () => void)();
    } finally {
      process.stderr.write = writeErr;
      process.stdout.write = writeOut;
    }

    expect(err).to.include('`dcd live` is deprecated').and.include('dcd device');
    expect(out).to.equal('');
  });
});

describe('launch: listed in help', () => {
  it('lists dcd device and dcd mcp', async () => {
    const { deviceCommand } = await import('../../src/commands/device.js');
    const { mcpCommand } = await import('../../src/commands/mcp.js');
    expect((deviceCommand.meta as { hidden?: boolean }).hidden).to.not.equal(true);
    expect((mcpCommand.meta as { hidden?: boolean }).hidden).to.not.equal(true);
  });
});
