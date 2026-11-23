import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { localOutput } from '../../src/mcp/local-files.js';
import { resolveArtifactsPath } from '../../src/utils/paths.js';

describe('resolveArtifactsPath', () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-artifacts-path-')));
  });

  after(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it('puts artifacts.zip inside an existing folder', () => {
    expect(resolveArtifactsPath(tempDir)).to.equal(path.join(tempDir, 'artifacts.zip'));
  });

  it('treats a trailing separator as a folder, even one that does not exist yet', () => {
    const dir = path.join(tempDir, 'later') + '/';
    expect(resolveArtifactsPath(dir)).to.equal(path.join(tempDir, 'later', 'artifacts.zip'));
  });

  it('leaves a file path alone, existing or not', () => {
    const file = path.join(tempDir, 'mine.zip');
    expect(resolveArtifactsPath(file)).to.equal(file);
    fs.writeFileSync(file, 'x');
    expect(resolveArtifactsPath(file)).to.equal(file);
  });

  it('is harmless to apply twice', () => {
    const once = resolveArtifactsPath(tempDir);
    expect(resolveArtifactsPath(once)).to.equal(once);
  });

  it('checks a ~ path against the home folder and keeps the ~', () => {
    expect(resolveArtifactsPath('~')).to.equal(path.join('~', 'artifacts.zip'));
  });

  // The MCP tool resolves the folder first, so its write check runs on the
  // file. A folder given as is would be refused as "already exists".
  it('lets the MCP write check pass for a folder inside the working directory', () => {
    const dir = path.join(tempDir, 'out');
    fs.mkdirSync(dir);
    expect(localOutput(resolveArtifactsPath(dir), tempDir)).to.equal(
      path.join(dir, 'artifacts.zip'),
    );
    expect(() => localOutput(dir, tempDir)).to.throw(/already exists/);
  });
});
