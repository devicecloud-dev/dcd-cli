import { expect } from 'chai';
import { type ArgsDef, type CommandDef, parseArgs, renderUsage } from 'citty';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { cloudCommand } from '../../src/commands/cloud.js';
import { uploadCommand } from '../../src/commands/upload.js';
import { withoutHiddenArgs } from '../../src/utils/help.js';

/**
 * While client-side encryption is a per-org beta (dcd#1138), --encrypt and
 * --no-encrypt are left out of --help but must still parse.
 */
const commands: Array<[string, CommandDef<ArgsDef>]> = [
  ['cloud', cloudCommand as CommandDef<ArgsDef>],
  ['upload', uploadCommand as CommandDef<ArgsDef>],
];

async function argsOf(cmd: CommandDef<ArgsDef>): Promise<ArgsDef> {
  return (typeof cmd.args === 'function' ? await cmd.args() : await cmd.args) ?? {};
}

describe('hidden --encrypt flag', () => {
  for (const [name, cmd] of commands) {
    describe(`dcd ${name}`, () => {
      it('leaves encrypt out of the usage', async () => {
        const usage = await renderUsage(await withoutHiddenArgs(cmd));
        expect(usage).to.not.match(/encrypt/i);
        // Everything else still renders.
        expect(usage).to.contain('--api-key');
      });

      it('would list it without the filter, so the test above means something', async () => {
        expect(await renderUsage(cmd)).to.contain('--encrypt');
      });

      it('still parses --encrypt and --no-encrypt', async () => {
        const args = await argsOf(cmd);
        expect(parseArgs(['--encrypt'], args).encrypt).to.equal(true);
        expect(parseArgs(['--no-encrypt'], args).encrypt).to.equal(false);
        expect(parseArgs([], args).encrypt).to.equal(undefined);
      });
    });
  }

  it('does not change the command it filters', async () => {
    await withoutHiddenArgs(cloudCommand as CommandDef<ArgsDef>);
    expect(await argsOf(cloudCommand as CommandDef<ArgsDef>)).to.have.property('encrypt');
  });

  describe('through the real entry point', () => {
    let configDir: string;

    before(() => {
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-help-test-'));
    });

    after(() => {
      fs.rmSync(configDir, { force: true, recursive: true });
    });

    for (const name of ['cloud', 'upload']) {
      it(`dcd ${name} --help does not mention encrypt`, () => {
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
        expect(out).to.not.match(/encrypt/i);
      });
    }
  });
});
