import { expect } from 'chai';
import { type ArgsDef, type CommandDef, parseArgs, renderUsage } from 'citty';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { cloudCommand } from '../../src/commands/cloud.js';
import { uploadCommand } from '../../src/commands/upload.js';

/**
 * Uploads are always encrypted (dcd#1138). --encrypt stays as a no-op so old
 * scripts still run, and --no-encrypt must still parse so it can be ignored
 * with a warning rather than fail.
 */
const commands: Array<[string, CommandDef<ArgsDef>]> = [
  ['cloud', cloudCommand as CommandDef<ArgsDef>],
  ['upload', uploadCommand as CommandDef<ArgsDef>],
];

async function argsOf(cmd: CommandDef<ArgsDef>): Promise<ArgsDef> {
  return (typeof cmd.args === 'function' ? await cmd.args() : await cmd.args) ?? {};
}

describe('--encrypt flag', () => {
  for (const [name, cmd] of commands) {
    describe(`dcd ${name}`, () => {
      it('lists encrypt in the usage, as no longer needed', async () => {
        const usage = await renderUsage(cmd);
        expect(usage).to.contain('--encrypt');
        expect(usage).to.contain('always encrypted');
        expect(usage).to.not.contain('turns it off');
      });

      it('parses --encrypt and --no-encrypt', async () => {
        const args = await argsOf(cmd);
        expect(parseArgs(['--encrypt'], args).encrypt).to.equal(true);
        expect(parseArgs(['--no-encrypt'], args).encrypt).to.equal(false);
        expect(parseArgs([], args).encrypt).to.equal(undefined);
      });
    });
  }

  describe('through the real entry point', () => {
    let configDir: string;

    before(() => {
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-help-test-'));
    });

    after(() => {
      fs.rmSync(configDir, { force: true, recursive: true });
    });

    for (const name of ['cloud', 'upload']) {
      it(`dcd ${name} --help lists --encrypt`, () => {
        const out = execFileSync(
          process.execPath,
          ['--import', 'tsx/esm', path.resolve('src/index.ts'), name, '--help'],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              DCD_CONFIG_DIR: configDir,
              DCD_TELEMETRY_DISABLED: '1',
              NO_COLOR: '1',
            },
          },
        );
        expect(out).to.contain(`dcd ${name}`);
        expect(out).to.contain('--encrypt');
      });
    }
  });
});
