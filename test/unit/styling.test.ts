import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Colour support is decided once per process from its streams and env, so each
 * case runs the styling module in a child process whose stdout and stderr are
 * pipes, never the terminal mocha may be running in.
 */
const stylingUrl = pathToFileURL(path.resolve('src/utils/styling.ts')).href;

const probe = `
const { colors, forStderr, symbols } = await import(${JSON.stringify(stylingUrl)});
process.stdout.write(JSON.stringify({
  bold: colors.bold('b'),
  dimNull: colors.dim(null),
  error: colors.error('e'),
  forStderr: forStderr('\\u001B[31mx\\u001B[39m'),
  success: symbols.success,
  url: colors.url('u'),
}));
`;

function runProbe(env: Record<string, string>): Record<string, string> {
  const inherited = { ...process.env };
  delete inherited.FORCE_COLOR;
  delete inherited.NO_COLOR;
  delete inherited.NODE_DISABLE_COLORS;
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '-e', probe],
    { encoding: 'utf8', env: { ...inherited, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out) as Record<string, string>;
}

describe('styling', function () {
  // Each case starts a node + tsx child process.
  this.timeout(30_000);

  it('prints plain text when stdout is not a terminal', () => {
    const r = runProbe({});
    expect(r.bold).to.equal('b');
    expect(r.error).to.equal('e');
    expect(r.url).to.equal('u');
    expect(r.success).to.equal('✓');
  });

  it('strips colour bound for stderr when stderr is not a terminal', () => {
    expect(runProbe({}).forStderr).to.equal('x');
  });

  it('colours under FORCE_COLOR, nesting formats for url', () => {
    const r = runProbe({ FORCE_COLOR: '1' });
    expect(r.bold).to.equal('\u001B[1mb\u001B[22m');
    expect(r.error).to.equal('\u001B[31me\u001B[39m');
    expect(r.url).to.equal('\u001B[36m\u001B[4mu\u001B[24m\u001B[39m');
    expect(r.success).to.equal('\u001B[32m✓\u001B[39m');
  });

  it('prints plain text under FORCE_COLOR=0', () => {
    const r = runProbe({ FORCE_COLOR: '0' });
    expect(r.url).to.equal('u');
    expect(r.forStderr).to.equal('x');
  });

  it('keeps colour bound for stderr when stderr takes colour', () => {
    expect(runProbe({ FORCE_COLOR: '1' }).forStderr).to.equal('\u001B[31mx\u001B[39m');
  });

  it('prints a non-string value instead of throwing', () => {
    expect(runProbe({}).dimNull).to.equal('null');
  });
});
