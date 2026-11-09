import { expect } from 'chai';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/stable-release.mjs works out, writes and checks a stable release
 * (.github/workflows/promote.yml and release-please.yml). It is driven here as
 * those workflows drive it: as a subprocess, inside a throwaway git repo with a
 * `production` branch tagged at the last release and a `dev` branch ahead of it.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts/stable-release.mjs');
const REPO = 'https://github.com/devicecloud-dev/dcd-cli';

// git without the developer's own config: no signing, hooks or default branch.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_AUTHOR_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
};

const PACKAGE_JSON = `{
  "name": "@devicecloud.dev/dcd",
  "repository": {
    "type": "git",
    "url": "git+${REPO}.git"
  },
  "version": "1.4.0",
  "devDependencies": {
    "pinned": "1.4.0"
  }
}
`;

const SERVER_JSON = `{
  "name": "dev.devicecloud/dcd",
  "version": "1.4.0",
  "packages": [
    {
      "identifier": "@devicecloud.dev/dcd",
      "version": "1.4.0"
    }
  ]
}
`;

const OLD_SECTION = `## [1.4.0](${REPO}/compare/v1.3.0...v1.4.0) (2026-01-01)


### Features

* an older feature
`;

describe('scripts/stable-release.mjs', () => {
  let dir: string;
  let outputFile: string;

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  const commit = (message: string): string => {
    git('commit', '--allow-empty', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  const read = (file: string): string => fs.readFileSync(path.join(dir, file), 'utf8');
  const write = (file: string, text: string): void =>
    fs.writeFileSync(path.join(dir, file), text);

  const run = (...args: string[]) => {
    fs.writeFileSync(outputFile, '');
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...GIT_ENV, GITHUB_ACTIONS: '', GITHUB_OUTPUT: outputFile },
    });
    return { ...result, outputs: fs.readFileSync(outputFile, 'utf8') };
  };
  const plan = (...args: string[]) =>
    run('plan', '--base', 'production', '--date', '2026-11-09', '--notes-out', 'notes.md', ...args);

  const link = (sha: string) => `([${sha.slice(0, 7)}](${REPO}/commit/${sha}))`;
  const pr = (n: number) => `([#${n}](${REPO}/issues/${n}))`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-stable-release-'));
    outputFile = path.join(dir, '.github-output');
    git('init', '--quiet', '--initial-branch', 'production');
    write('.gitignore', 'notes.md\n.github-output\n');
    write('package.json', PACKAGE_JSON);
    write('server.json', SERVER_JSON);
    write('CHANGELOG.md', `# Changelog\n\n${OLD_SECTION}`);
    git('add', '.');
    commit('chore: release 1.4.0');
    git('tag', 'v1.4.0');
    git('checkout', '--quiet', '-b', 'dev');
  });

  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('derives a minor from a feat and lists each releasable PR once', () => {
    const fix = commit('fix(cloud): retry a dropped upload (#11)');
    const feat = commit('feat: add a --quiet flag (#12)');
    commit('chore: tidy the scripts (#13)');
    commit('docs: explain the flag');

    const result = plan();

    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal('1.5.0\n');
    expect(result.outputs).to.include('version=1.5.0\n').and.include('previous=1.4.0\n').and.include('bump=minor\n');
    expect(read('notes.md')).to.equal(
      [
        `## [1.5.0](${REPO}/compare/v1.4.0...v1.5.0) (2026-11-09)`,
        '',
        '',
        '### Features',
        '',
        `* add a --quiet flag ${pr(12)} ${link(feat)}`,
        '',
        '',
        '### Bug Fixes',
        '',
        `* **cloud:** retry a dropped upload ${pr(11)} ${link(fix)}`,
        '',
      ].join('\n'),
    );
    // plan writes nothing but the notes.
    expect(read('package.json')).to.equal(PACKAGE_JSON);
  });

  it("derives a patch from dev's own commits, leaving out production's and merges", () => {
    commit('fix: handle an empty flow directory (#21)');
    commit('deps: bump the minor-and-patch group (#22)');
    git('checkout', '--quiet', 'production');
    commit('feat: a commit that only production has');
    git('checkout', '--quiet', 'dev');
    git('merge', '--quiet', '--no-ff', '-m', 'Merge branch production into dev', 'production');

    const result = plan();

    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal('1.4.1\n');
    expect(read('notes.md'))
      .to.include('### Bug Fixes')
      .and.include('### Dependencies')
      .and.not.include('only production has')
      .and.not.include('Merge branch');
  });

  it('uses the untruncated title from the body when the subject was cut short', () => {
    commit(
      'feat(report): deprecate allure and html-detailed, removed on 7 Decemb… (#298)\n\n' +
        'feat(report): deprecate allure and html-detailed, removed on 7 December 2026\n\n' +
        'The allure and html-detailed report formats are deprecated.',
    );

    const result = plan();

    expect(result.status, result.stderr).to.equal(0);
    expect(read('notes.md'))
      .to.include(`* **report:** deprecate allure and html-detailed, removed on 7 December 2026 ${pr(298)}`)
      .and.not.include('…');
  });

  it('never derives a major, but releases one that is asked for', () => {
    commit('refactor(cloud)!: rename --flows to --flow-dir (#30)');

    const derived = plan();
    expect(derived.status).to.equal(1);
    expect(derived.stderr).to.include('2.0.0').and.include('rename --flows');
    expect(fs.existsSync(path.join(dir, 'notes.md'))).to.equal(false);

    const requested = plan('--version', '2.0.0');
    expect(requested.status, requested.stderr).to.equal(0);
    expect(requested.outputs).to.include('bump=requested\n');
    expect(read('notes.md'))
      .to.include('### ⚠ BREAKING CHANGES\n\n* **cloud:** rename --flows to --flow-dir')
      .and.include('### Code Refactoring\n\n* **cloud:** rename --flows to --flow-dir');
  });

  it('treats a BREAKING CHANGE footer as breaking too', () => {
    commit('fix: drop the legacy upload path (#31)\n\nBREAKING CHANGE: CLIs older than 5.9.0 cannot upload.');

    expect(plan().stderr).to.include('2.0.0');
  });

  it('refuses a release with nothing in it unless a version is given', () => {
    commit('chore: tidy (#40)');
    commit('ci: cache pnpm (#41)');

    const derived = plan();
    expect(derived.status).to.equal(1);
    expect(derived.stderr).to.include('nothing to release');

    const requested = plan('--version', '1.4.1');
    expect(requested.status, requested.stderr).to.equal(0);
    expect(read('notes.md')).to.include('No user-facing changes.');
  });

  it('skips quietly with --skip-if-nothing, as a push run does', () => {
    commit('docs: explain the flag (#42)');

    const result = plan('--skip-if-nothing');
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.equal('');
    expect(result.outputs).to.equal('release=false\n');
    expect(fs.existsSync(path.join(dir, 'notes.md'))).to.equal(false);
  });

  it("keeps the open release PR's version unless the commits now call for more", () => {
    commit('fix: handle an empty flow directory (#43)');

    // A version set by hand, above what the commits call for, survives.
    const kept = plan('--keep', '1.6.0');
    expect(kept.stdout).to.equal('1.6.0\n');
    expect(kept.outputs).to.include('bump=kept\n');

    // A kept version equal to or below the derived one gives way to it.
    expect(plan('--keep', '1.4.1').outputs).to.include('version=1.4.1\n').and.include('bump=patch\n');
    commit('feat: add a --quiet flag (#44)');
    expect(plan('--keep', '1.4.1').stdout).to.equal('1.5.0\n');

    // One that is no longer ahead of production (its release merged) is ignored.
    expect(plan('--keep', '1.4.0').stdout).to.equal('1.5.0\n');
  });

  it('keeps a major once it has been set by hand, but never derives one', () => {
    commit('refactor(cloud)!: rename --flows to --flow-dir (#45)');

    expect(plan('--keep', '1.5.0').status).to.equal(1);
    expect(plan('--keep', '2.0.0').stdout).to.equal('2.0.0\n');
    expect(plan('--keep', '2.0.0', '--skip-if-nothing').stdout).to.equal('2.0.0\n');
  });

  it('refuses a version that is not new', () => {
    commit('feat: something (#50)');

    expect(plan('--version', '1.4.0').stderr).to.include('not above 1.4.0');
    expect(plan('--version', '1.5.0-beta.1').stderr).to.include('not a stable X.Y.Z version');

    git('tag', 'v1.6.0');
    expect(plan('--version', '1.5.0').stderr).to.include('not above v1.6.0');
    expect(plan('--version', '1.6.0').stderr).to.include('not above v1.6.0');
  });

  it('writes the release into the version files and changelog, which verify accepts', () => {
    commit('feat: add a --quiet flag (#12)');
    expect(plan().status).to.equal(0);

    const apply = run('apply', '--version', '1.5.0', '--notes', 'notes.md');
    expect(apply.status, apply.stderr).to.equal(0);

    expect(read('package.json')).to.equal(PACKAGE_JSON.replace('"version": "1.4.0"', '"version": "1.5.0"'));
    expect(read('server.json')).to.equal(SERVER_JSON.replaceAll('1.4.0', '1.5.0'));
    expect(read('CHANGELOG.md')).to.equal(`# Changelog\n\n${read('notes.md')}\n${OLD_SECTION}`);

    const verify = run('verify');
    expect(verify.status, verify.stderr).to.equal(0);
    expect(verify.outputs).to.include('version=1.5.0\n').and.include('tag=v1.5.0\n');

    expect(run('notes').stdout).to.equal(read('notes.md'));
    expect(run('notes', '--version', '1.4.0').stdout).to.equal(OLD_SECTION);
    expect(run('notes', '--version', '1.3.0').status).to.equal(1);
  });

  it('verify rejects a tree that would not release cleanly', () => {
    const released = run('verify');
    expect(released.status).to.equal(1);
    expect(released.stderr).to.include('v1.4.0 is already tagged');

    commit('feat: add a --quiet flag (#12)');
    plan();
    run('apply', '--version', '1.5.0', '--notes', 'notes.md');
    write('server.json', SERVER_JSON.replace('"version": "1.4.0"', '"version": "1.5.0"'));
    write('CHANGELOG.md', `# Changelog\n\n${OLD_SECTION}`);

    const stale = run('verify');
    expect(stale.status).to.equal(1);
    expect(stale.stderr).to.include('server.json versions (1.5.0, 1.4.0)').and.include("newest section is 1.4.0, not 1.5.0");
  });

  it('refuses to apply when a version field it should not touch matches', () => {
    write('package.json', PACKAGE_JSON.replace('"pinned": "1.4.0"', '"version": "1.4.0"'));
    git('commit', '--quiet', '--all', '-m', 'chore: a nested version field');
    commit('feat: something (#60)');
    plan();

    const apply = run('apply', '--version', '1.5.0', '--notes', 'notes.md');
    expect(apply.status).to.equal(1);
    expect(apply.stderr).to.include('package.json');
  });

  it("changes only the version fields of the repo's own package.json and server.json", () => {
    const realPackage = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const realServer = fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8');
    const current = (JSON.parse(realPackage) as { version: string }).version;
    const [major, minor] = current.split('.').map(Number);
    const next = `${major}.${minor + 1}.0`;

    git('checkout', '--quiet', 'production');
    write('package.json', realPackage);
    write('server.json', realServer);
    git('commit', '--quiet', '--all', '-m', `chore: release ${current}`);
    git('tag', `v${current}`);
    git('checkout', '--quiet', 'dev');
    git('merge', '--quiet', 'production');
    commit('feat: something (#70)');

    expect(plan().stdout).to.equal(`${next}\n`);
    const apply = run('apply', '--version', next, '--notes', 'notes.md');
    expect(apply.status, apply.stderr).to.equal(0);

    const changed = (before: string, after: string) => {
      const lines = after.split('\n');
      return before.split('\n').flatMap((line, i) => (line === lines[i] ? [] : [lines[i].trim()]));
    };
    expect(changed(realPackage, read('package.json'))).to.deep.equal([`"version": "${next}",`]);
    expect(changed(realServer, read('server.json'))).to.deep.equal([
      `"version": "${next}",`,
      `"version": "${next}",`,
    ]);
  });
});
