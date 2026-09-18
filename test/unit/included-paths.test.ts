import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { plan } from '../../src/services/execution-plan.service.js';
import {
  checkIfFilesExistInWorkspace,
  isWorkspaceConfigFile,
} from '../../src/services/execution-plan.utils.js';
import { computeCommonRoot } from '../../src/services/flow-paths.js';
import { parseWorkspaceConfig } from '../../src/services/workspace-config.schema.js';

/**
 * Fixtures are built on disk because `includedPaths` is glob-driven — a stubbed
 * filesystem would test the stub, not `fs.globSync`'s actual matching.
 * Paths are composed with `path.join` so the assertions hold on Windows too.
 */
function makeWorkspace(
  files: Record<string, string>,
): { cleanup: () => void; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-included-'));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  }

  return { cleanup: () => fs.rmSync(root, { recursive: true, force: true }), root };
}

const FLOW = ['appId: com.example', '---', '- launchApp'].join('\n');

describe('includedPaths', () => {
  describe('schema', () => {
    it('accepts includedPaths without warning', () => {
      const warnings: string[] = [];
      const config = parseWorkspaceConfig(
        { includedPaths: ['screenshots/**'] },
        { filePath: 'config.yaml', warn: (m) => warnings.push(m) },
      );

      expect(config.includedPaths).to.deep.equal(['screenshots/**']);
      expect(warnings).to.deep.equal([]);
    });

    it('suggests includedPaths for near-miss keys', () => {
      const warnings: string[] = [];
      parseWorkspaceConfig(
        { assets: ['screenshots/**'] },
        { filePath: 'config.yaml', warn: (m) => warnings.push(m) },
      );

      expect(warnings.join('\n')).to.contain('did you mean includedPaths');
    });

    it('counts as a workspace-config key for shape detection', () => {
      const { cleanup, root } = makeWorkspace({
        'config.yaml': 'includedPaths:\n  - screenshots/**\n',
      });

      try {
        expect(isWorkspaceConfigFile(path.join(root, 'config.yaml'))).to.equal(
          true,
        );
      } finally {
        cleanup();
      }
    });
  });

  describe('resolution', () => {
    it('bundles files no flow command references', async () => {
      const { cleanup, root } = makeWorkspace({
        'config.yaml': 'includedPaths:\n  - screenshots/**\n',
        'screenshots/home.png': 'png-bytes',
        'visual.yaml': FLOW,
      });

      try {
        const result = await plan({ input: root, warn: () => {} });
        expect(result.includedFiles).to.deep.equal([
          path.join(root, 'screenshots', 'home.png'),
        ]);
        // The baseline is NOT a flow-command reference — that is the whole
        // point. referencedFiles holds only the flow its BFS was seeded with.
        expect(result.referencedFiles).to.deep.equal([
          path.join(root, 'visual.yaml'),
        ]);
      } finally {
        cleanup();
      }
    });

    it('skips directories that match the glob', async () => {
      const { cleanup, root } = makeWorkspace({
        'assets/nested/keep.png': 'png-bytes',
        'config.yaml': 'includedPaths:\n  - assets/**\n',
        'visual.yaml': FLOW,
      });

      try {
        const result = await plan({ input: root, warn: () => {} });
        expect(result.includedFiles).to.deep.equal([
          path.join(root, 'assets', 'nested', 'keep.png'),
        ]);
      } finally {
        cleanup();
      }
    });

    it('warns when a pattern matches nothing', async () => {
      const { cleanup, root } = makeWorkspace({
        'config.yaml': 'includedPaths:\n  - screenshots/**\n',
        'visual.yaml': FLOW,
      });
      const warnings: string[] = [];

      try {
        const result = await plan({
          input: root,
          warn: (m) => warnings.push(m),
        });
        expect(result.includedFiles).to.deep.equal([]);
        expect(warnings.join('\n')).to.contain('matched no files');
      } finally {
        cleanup();
      }
    });

    it('refuses a pattern that escapes the workspace', async () => {
      const { cleanup, root } = makeWorkspace({
        'config.yaml': 'includedPaths:\n  - ../outside.png\n',
        'visual.yaml': FLOW,
      });
      fs.writeFileSync(path.join(root, '..', 'outside.png'), 'png-bytes');

      try {
        await plan({ input: root, warn: () => {} });
        expect.fail('expected the containment guard to throw');
      } catch (error) {
        expect((error as Error).message).to.contain(
          'resolves outside the workspace',
        );
      } finally {
        cleanup();
      }
    });
  });

  describe('computeCommonRoot', () => {
    it('folds included files in so the zip can strip the prefix', () => {
      const flows = [path.join('/a', 'b', 'flows', 'login.yaml')];
      const included = [path.join('/a', 'b', 'screenshots', 'home.png')];

      // Without the included file the root sits at the flows dir; folding it in
      // raises the root so the flow -> baseline relative offset survives the zip.
      expect(computeCommonRoot(flows, [])).to.equal(
        path.join('/a', 'b', 'flows'),
      );
      expect(computeCommonRoot(flows, [], included)).to.equal(
        path.join('/a', 'b'),
      );
    });

    it('defaults includedFiles so existing callers are unaffected', () => {
      const flows = [path.join('/a', 'b', 'login.yaml')];
      expect(computeCommonRoot(flows, [])).to.equal(path.join('/a', 'b'));
    });
  });

  describe('assertScreenshot dependency walking', () => {
    const flowPath = path.join('/ws', 'visual.yaml');

    it('does not error on a missing baseline', () => {
      const { errors, files } = checkIfFilesExistInWorkspace(
        'assertScreenshot',
        'screenshots/home.png',
        flowPath,
      );

      // Maestro's own "searched in:" message is better than ours, and a first
      // run legitimately has no baseline — so this must not abort the upload.
      expect(errors).to.deep.equal([]);
      expect(files).to.deep.equal([]);
    });

    it('still errors on a missing addMedia file', () => {
      const { errors } = checkIfFilesExistInWorkspace(
        'addMedia',
        'screenshots/home.png',
        flowPath,
      );
      expect(errors).to.have.lengthOf(1);
    });

    it('bundles an existing baseline referenced by the object path key', () => {
      const { cleanup, root } = makeWorkspace({
        'screenshots/home.png': 'png-bytes',
        'visual.yaml': FLOW,
      });

      try {
        const { errors, files } = checkIfFilesExistInWorkspace(
          'assertScreenshot',
          { path: 'screenshots/home.png' },
          path.join(root, 'visual.yaml'),
        );
        expect(errors).to.deep.equal([]);
        expect(files).to.deep.equal([path.join(root, 'screenshots', 'home.png')]);
      } finally {
        cleanup();
      }
    });

    it('appends .png when the path has no image extension', () => {
      const { cleanup, root } = makeWorkspace({
        'screenshots/home.png': 'png-bytes',
        'visual.yaml': FLOW,
      });

      try {
        // Mirrors Maestro's normalizeScreenshotPath: `assertScreenshot: home`
        // resolves to home.png on the device, so it must here too.
        const { files } = checkIfFilesExistInWorkspace(
          'assertScreenshot',
          'screenshots/home',
          path.join(root, 'visual.yaml'),
        );
        expect(files).to.deep.equal([path.join(root, 'screenshots', 'home.png')]);
      } finally {
        cleanup();
      }
    });

    it('skips an interpolated path rather than guessing', () => {
      const { errors, files } = checkIfFilesExistInWorkspace(
        'assertScreenshot',
        'screenshots/${DCD_DEVICE}/home.png',
        flowPath,
      );

      // Per-device baselines are what `includedPaths` is for; a static walk
      // cannot resolve the variable.
      expect(errors).to.deep.equal([]);
      expect(files).to.deep.equal([]);
    });
  });
});
