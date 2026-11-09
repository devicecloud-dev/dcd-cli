#!/usr/bin/env node
/**
 * Stable releases: work out the next version, write it, and check it.
 *
 * A stable release is ONE pull request into `production`, built by
 * .github/workflows/promote.yml: `dev`, with `production` merged in, plus a
 * commit that sets the version in package.json and server.json and adds the
 * CHANGELOG.md section. Merging it is the release: release-please.yml sees an
 * untagged version on `production`, tags it, creates the GitHub Release from
 * the changelog section, and publishes.
 *
 * This replaced release-please, which needed a promotion PR, a `Release-As:`
 * pin on it (or it based the version on a beta tag), and then a second Release
 * PR. Here the version is derived from the same Conventional Commit PR titles,
 * in one place, and the release PR is the only PR.
 *
 * Usage:
 *   node scripts/stable-release.mjs plan   [--version X.Y.Z] [--keep X.Y.Z] [--skip-if-nothing]
 *                                          [--base <ref>] [--head <ref>]
 *                                          [--date YYYY-MM-DD] [--notes-out <file>]
 *   node scripts/stable-release.mjs apply  --version X.Y.Z --notes <file>
 *   node scripts/stable-release.mjs verify
 *   node scripts/stable-release.mjs notes  [--version X.Y.Z]
 *
 * plan   Derives the version from the commits in base..head (default
 *        origin/production..HEAD) and renders the changelog section. Writes
 *        nothing but --notes-out. Prints the version on stdout.
 *        --keep is the version of the release PR already open: a derived
 *        version never goes below it, so a version set by hand (a major, say)
 *        survives the automatic rebuilds on later pushes to dev.
 *        --skip-if-nothing exits 0 with release=false when nothing is
 *        releasable, instead of failing.
 * apply  Sets the version in package.json and server.json, and puts the section
 *        at the top of CHANGELOG.md, in the working tree.
 * verify Checks the working tree is an unreleased, self-consistent release. The
 *        CI check on PRs into production and the Release workflow both run it.
 * notes  Prints a version's CHANGELOG.md section (default: package.json's).
 *
 * plan and verify append key=value lines to $GITHUB_OUTPUT when it is set.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// Conventional Commit type -> changelog section, in the order the sections are
// printed. A type in a section bumps the patch (feat: the minor); the hidden
// types are left out of the changelog and bump nothing. Keep both lists in
// lockstep with the allowed types in .github/workflows/pr-title-lint.yml.
const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Bug Fixes'],
  ['perf', 'Performance'],
  ['deps', 'Dependencies'],
  ['revert', 'Reverts'],
  ['refactor', 'Code Refactoring'],
];
const HIDDEN = new Set(['docs', 'chore', 'test', 'ci', 'build', 'style']);
const RELEASABLE = new Set(SECTIONS.map(([type]) => type));

// Stable versions only. The stable line never carries a prerelease; betas are
// cut separately by release-beta.yml and never come through here.
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

const HEADER = /^(\w+)(?:\(([^()\r\n]+)\))?(!)?: (.+)$/;
const PR_SUFFIX = / \(#(\d+)\)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/;

class ReleaseError extends Error {}

// GitHub Actions annotations in CI, plain prefixes everywhere else.
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const ERROR = IN_ACTIONS ? '::error::' : 'Error: ';
const WARNING = IN_ACTIONS ? '::warning::' : 'Warning: ';

// ---------------------------------------------------------------------------
// Versions

function parseVersion(version) {
  const match = STABLE.exec(version ?? '');
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function bumpVersion(version, bump) {
  const [major, minor, patch] = parseVersion(version);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// ---------------------------------------------------------------------------
// Commits

/**
 * One commit, as the changelog sees it. PRs are squash-merged, so the subject
 * is the PR title: `type(scope)!: description (#123)`.
 *
 * Long PR titles reach us cut short with an ellipsis. GitHub does that when it
 * builds a title from a long commit subject, and again when it builds the
 * squash subject from a long title, and puts the uncut text in the body. So a
 * subject ending in `…` is replaced by the body line it is the start of, when
 * there is one. release-please split those bodies into extra commits instead,
 * which listed every such PR twice.
 */
function parseCommit(sha, message) {
  const [first = '', ...body] = message.replace(/\r\n/g, '\n').trim().split('\n');
  let subject = first.trim();

  let pr = null;
  const prMatch = PR_SUFFIX.exec(subject);
  if (prMatch) {
    pr = Number(prMatch[1]);
    subject = subject.slice(0, prMatch.index);
  }

  if (subject.endsWith('…')) {
    const stem = subject.slice(0, -1);
    const full = body
      .map((line) => line.trim())
      .find((line) => line.length > stem.length && line.startsWith(stem));
    if (full) subject = full.replace(PR_SUFFIX, '');
  }

  const header = HEADER.exec(subject);
  if (!header) return { sha, subject, type: null, scope: null, description: subject, pr, breaking: false };

  const [, type, scope, bang, description] = header;
  const breaking = Boolean(bang) || body.some((line) => BREAKING_FOOTER.test(line.trim()));
  return { sha, subject, type: type.toLowerCase(), scope: scope ?? null, description, pr, breaking };
}

/** null when nothing in `commits` calls for a release. */
function bumpFor(commits) {
  let bump = null;
  for (const commit of commits) {
    if (commit.breaking) return 'major';
    if (commit.type === 'feat') bump = 'minor';
    else if (!bump && RELEASABLE.has(commit.type)) bump = 'patch';
  }
  return bump;
}

// ---------------------------------------------------------------------------
// Changelog

function entry(commit, repoUrl) {
  const scope = commit.scope ? `**${commit.scope}:** ` : '';
  const pr = commit.pr ? ` ([#${commit.pr}](${repoUrl}/issues/${commit.pr}))` : '';
  return `* ${scope}${commit.description}${pr} ([${commit.sha.slice(0, 7)}](${repoUrl}/commit/${commit.sha}))`;
}

// Unscoped entries first, then by scope, then by description: the order
// release-please used, so the file reads the same above and below the switch.
function byScopeThenDescription(a, b) {
  if (a.scope !== b.scope) {
    if (!a.scope) return -1;
    if (!b.scope) return 1;
    return a.scope.localeCompare(b.scope);
  }
  return a.description.localeCompare(b.description);
}

/**
 * The CHANGELOG.md section for a release, in release-please's layout (two
 * blank lines before each subsection). It is also the GitHub Release body.
 */
function renderSection({ version, previous, date, commits, repoUrl }) {
  const groups = [];
  const breaking = commits.filter((c) => c.breaking);
  if (breaking.length > 0) groups.push(['⚠ BREAKING CHANGES', breaking]);
  for (const [type, title] of SECTIONS) {
    const inSection = commits.filter((c) => c.type === type);
    if (inSection.length > 0) groups.push([title, inSection]);
  }

  const lines = [`## [${version}](${repoUrl}/compare/v${previous}...v${version}) (${date})`];
  if (groups.length === 0) {
    lines.push('', '', 'No user-facing changes.');
  }
  for (const [title, inGroup] of groups) {
    lines.push('', '', `### ${title}`, '');
    lines.push(...[...inGroup].sort(byScopeThenDescription).map((c) => entry(c, repoUrl)));
  }
  return `${lines.join('\n')}\n`;
}

const SECTION_HEADING = /^## \[([^\]]+)\]/;

function firstSectionVersion(changelog) {
  for (const line of changelog.split('\n')) {
    const match = SECTION_HEADING.exec(line);
    if (match) return match[1];
  }
  return null;
}

function insertSection(changelog, section) {
  const lines = changelog.split('\n');
  const at = lines.findIndex((line) => SECTION_HEADING.test(line));
  if (at === -1) return `${changelog.trimEnd()}\n\n${section}`;
  const head = lines.slice(0, at).join('\n');
  const rest = lines.slice(at).join('\n');
  return `${head}${head ? '\n' : ''}${section}\n${rest}`;
}

function extractSection(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => SECTION_HEADING.exec(line)?.[1] === version);
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && SECTION_HEADING.test(line));
  if (end === -1) end = lines.length;
  return `${lines.slice(start, end).join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Version files

/**
 * Rewrites the version strings in a JSON file without reformatting it: a
 * textual replace of `"version": "<previous>"`, checked against the same edit
 * made on the parsed object, so a stray match or a missed field fails loudly.
 */
function rewriteJsonVersions(path, previous, version, setVersions) {
  const text = readFileSync(path, 'utf8');
  const expected = JSON.parse(text);
  setVersions(expected, version);

  const pattern = new RegExp(`("version"\\s*:\\s*")${previous.replaceAll('.', '\\.')}"`, 'g');
  const rewritten = text.replace(pattern, `$1${version}"`);
  if (!isDeepStrictEqual(JSON.parse(rewritten), expected)) {
    throw new ReleaseError(
      `${path}: rewriting "version": "${previous}" to ${version} did not produce the expected file. ` +
        `Its version fields must all read ${previous} before a release.`,
    );
  }
  writeFileSync(path, rewritten);
}

const setPackageVersion = (pkg, version) => {
  pkg.version = version;
};

// server.json is the MCP registry manifest: its own version and every npm
// package entry's version track the release. Nothing else in it may carry a
// version (see test/unit/server-json.test.ts).
const setServerVersions = (server, version) => {
  server.version = version;
  for (const pkg of server.packages ?? []) pkg.version = version;
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// Git

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function tagExists(tag) {
  try {
    git('rev-parse', '--quiet', '--verify', `refs/tags/${tag}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

function highestStableTag() {
  const versions = git('tag', '--list', 'v*')
    .split('\n')
    .map((tag) => tag.trim().replace(/^v/, ''))
    .filter((v) => parseVersion(v));
  return versions.sort(compareVersions).at(-1) ?? null;
}

const RECORD = '\u001E';
const FIELD = '\u001F';

/** Non-merge commits in base..head, oldest first. */
function commitsBetween(base, head) {
  return git('log', '--no-merges', '--reverse', `--format=%H${FIELD}%B${RECORD}`, `${base}..${head}`)
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, message = ''] = record.split(FIELD);
      return parseCommit(sha.trim(), message);
    });
}

function repoUrl(pkg) {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!url) throw new ReleaseError('package.json has no repository url to link the changelog to');
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

// ---------------------------------------------------------------------------
// Commands

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? '' : (process.argv[i + 1] ?? '').trim();
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

function describe(commit) {
  return `  ${commit.sha.slice(0, 7)} ${commit.subject}${commit.pr ? ` (#${commit.pr})` : ''}`;
}

function majorError(commits, previous) {
  const breaking = commits.filter((c) => c.breaking).map(describe).join('\n');
  return new ReleaseError(
    `these commits are marked breaking, which calls for ${bumpVersion(previous, 'major')}:\n${breaking}\n` +
      'A major is never derived. If it is intended, run "Promote to stable" with that version once; ' +
      'later runs keep it.',
  );
}

function plan() {
  const base = arg('base') || 'origin/production';
  const head = arg('head') || 'HEAD';
  const requested = arg('version');
  const keep = arg('keep');
  const date = arg('date') || new Date().toISOString().slice(0, 10);
  if (keep && !parseVersion(keep)) throw new ReleaseError(`--keep "${keep}" is not a stable X.Y.Z version`);

  const basePackage = JSON.parse(git('show', `${base}:package.json`));
  const previous = basePackage.version;
  if (!parseVersion(previous)) {
    throw new ReleaseError(`${base} is on "${previous}", which is not a stable X.Y.Z version`);
  }
  if (!tagExists(`v${previous}`)) {
    throw new ReleaseError(`${base} is on ${previous}, but there is no v${previous} tag to release on top of`);
  }

  const commits = commitsBetween(base, head);
  const bump = bumpFor(commits);
  const derived = bump && bump !== 'major' ? bumpVersion(previous, bump) : null;
  // A kept version only counts while it is still ahead of the base: once its
  // release has merged, the open PR it came from is gone anyway.
  const kept = keep && compareVersions(keep, previous) > 0 ? keep : null;

  let version;
  let how;
  if (requested) {
    if (!parseVersion(requested)) throw new ReleaseError(`"${requested}" is not a stable X.Y.Z version`);
    version = requested;
    how = 'requested';
  } else if (!bump && !kept) {
    const message = `nothing to release: no ${[...RELEASABLE].join('/')} commits in ${base}..${head}`;
    if (process.argv.includes('--skip-if-nothing')) {
      console.error(`${message}.`);
      output({ release: 'false' });
      return;
    }
    throw new ReleaseError(`${message}. Pass a version to release anyway.`);
  } else if (kept && (!derived || compareVersions(kept, derived) > 0)) {
    // CLAUDE.md: a `!` in a PR title once turned a flag rename into a 6.0.0
    // release PR. A major is never derived; it has to be asked for once, and
    // is kept from then on.
    if (bump === 'major' && compareVersions(kept, bumpVersion(previous, 'major')) < 0) {
      throw majorError(commits, previous);
    }
    version = kept;
    how = 'kept';
  } else if (bump === 'major') {
    throw majorError(commits, previous);
  } else {
    version = derived;
    how = bump;
  }

  if (compareVersions(version, previous) <= 0) {
    throw new ReleaseError(`${version} is not above ${previous}, the version ${base} is on`);
  }
  const highest = highestStableTag();
  if (highest && compareVersions(version, highest) <= 0) {
    throw new ReleaseError(`${version} is not above v${highest}, the highest stable tag`);
  }
  if (tagExists(`v${version}`)) throw new ReleaseError(`tag v${version} already exists`);

  const section = renderSection({ version, previous, date, commits, repoUrl: repoUrl(basePackage) });
  const notesOut = arg('notes-out');
  if (notesOut) writeFileSync(notesOut, section);

  const listed = commits.filter((c) => RELEASABLE.has(c.type) || c.breaking);
  const hidden = commits.filter((c) => HIDDEN.has(c.type) && !c.breaking);
  const unparsed = commits.filter((c) => !c.type);
  console.error(`${previous} -> ${version} (${how}), ${base}..${head}`);
  console.error(`In the changelog (${listed.length}):\n${listed.map(describe).join('\n') || '  none'}`);
  if (hidden.length > 0) console.error(`Left out, hidden types (${hidden.length}):\n${hidden.map(describe).join('\n')}`);
  if (unparsed.length > 0) {
    console.error(`${WARNING}Left out, not Conventional Commits (${unparsed.length}):\n${unparsed.map(describe).join('\n')}`);
  }

  console.log(version);
  output({ release: 'true', version, previous, bump: how, tag: `v${version}` });
}

function apply() {
  const version = arg('version');
  const notes = arg('notes');
  if (!parseVersion(version)) throw new ReleaseError('apply needs --version X.Y.Z');
  if (!notes) throw new ReleaseError('apply needs --notes <file> (from plan --notes-out)');

  const previous = readJson('package.json').version;
  const section = readFileSync(notes, 'utf8');
  if (firstSectionVersion(section) !== version) {
    throw new ReleaseError(`${notes} is not the changelog section for ${version}`);
  }

  rewriteJsonVersions('package.json', previous, version, setPackageVersion);
  rewriteJsonVersions('server.json', previous, version, setServerVersions);
  writeFileSync('CHANGELOG.md', insertSection(readFileSync('CHANGELOG.md', 'utf8'), section));
  console.error(`package.json, server.json and CHANGELOG.md now carry ${version}`);
}

function verify() {
  const version = readJson('package.json').version;
  const problems = [];

  if (!parseVersion(version)) problems.push(`package.json is on "${version}", not a stable X.Y.Z version`);

  const server = readJson('server.json');
  const serverVersions = [server.version, ...(server.packages ?? []).map((p) => p.version)];
  if (serverVersions.some((v) => v !== version)) {
    problems.push(`server.json versions (${serverVersions.join(', ')}) do not all match package.json's ${version}`);
  }

  const changelogVersion = firstSectionVersion(readFileSync('CHANGELOG.md', 'utf8'));
  if (changelogVersion !== version) {
    problems.push(`CHANGELOG.md's newest section is ${changelogVersion ?? 'missing'}, not ${version}`);
  }

  if (parseVersion(version)) {
    if (tagExists(`v${version}`)) {
      problems.push(`v${version} is already tagged, so this would release nothing`);
    } else {
      const highest = highestStableTag();
      if (highest && compareVersions(version, highest) <= 0) {
        problems.push(`${version} is not above v${highest}, the highest stable tag`);
      }
    }
  }

  if (problems.length > 0) {
    throw new ReleaseError(
      `not a releasable stable version:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'Stable releases are built by the "Promote to stable" workflow (.github/workflows/promote.yml).',
    );
  }
  console.error(`${version} is ready to release`);
  console.log(version);
  output({ version, tag: `v${version}` });
}

function notes() {
  const version = arg('version') || readJson('package.json').version;
  const section = extractSection(readFileSync('CHANGELOG.md', 'utf8'), version);
  if (!section) throw new ReleaseError(`CHANGELOG.md has no section for ${version}`);
  process.stdout.write(section);
}

const COMMANDS = { plan, apply, verify, notes };
const command = COMMANDS[process.argv[2]];
if (!command) {
  console.error(`Usage: node scripts/stable-release.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
  process.exit(2);
}
try {
  command();
} catch (error) {
  if (!(error instanceof ReleaseError)) throw error;
  console.error(`${ERROR}${error.message.split('\n')[0]}`);
  const rest = error.message.split('\n').slice(1).join('\n');
  if (rest) console.error(rest);
  process.exit(1);
}
