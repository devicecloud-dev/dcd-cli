#!/usr/bin/env node
/**
 * Resolve the version for a manual beta release (.github/workflows/release-beta.yml).
 *
 * The beta line has no release-please manifest any more, so the npm registry is
 * the only state: whatever is published IS the source of truth. That is
 * deliberate. A manifest that numbered itself independently of what had actually
 * shipped is exactly how `@beta` ended up *older* than `@latest` three times
 * (5.0.0, 5.2.0 and 5.5.0) — each time needing a hand-written `Release-As` to
 * dig out. Deriving from the registry makes that impossible by construction:
 * the base is always a bump of the current `latest`, so a beta can never sort
 * below the stable it is meant to preview.
 *
 * Usage:
 *   node scripts/next-beta-version.mjs [--bump patch|minor|major] [--version X.Y.Z-beta.N]
 *
 * Prints the resolved version to stdout, and appends `version=<v>` to
 * $GITHUB_OUTPUT when that is set.
 */
const PACKAGE = '@devicecloud.dev/dcd';
const REGISTRY = 'https://registry.npmjs.org/@devicecloud.dev%2Fdcd';

// Deliberately NOT a general semver implementation — this package only ever
// publishes `X.Y.Z` and `X.Y.Z-beta.N`, and anything else reaching here means a
// wrong assumption somewhere upstream that should fail loudly rather than be
// silently coerced.
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const BETA = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/;

function parse(version) {
  const stable = STABLE.exec(version);
  if (stable) {
    const [, major, minor, patch] = stable;
    return { major: +major, minor: +minor, patch: +patch, beta: null };
  }
  const beta = BETA.exec(version);
  if (beta) {
    const [, major, minor, patch, n] = beta;
    return { major: +major, minor: +minor, patch: +patch, beta: +n };
  }
  return null;
}

/** -1 / 0 / 1. A prerelease sorts below the release it precedes. */
function compare(a, b) {
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  if (a.beta === b.beta) return 0;
  if (a.beta === null) return 1;
  if (b.beta === null) return -1;
  return a.beta < b.beta ? -1 : 1;
}

function bumpBase({ major, minor, patch }, kind) {
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump "${kind}" (expected patch, minor or major)`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return '';
  return (process.argv[i + 1] ?? '').trim();
}

const requested = arg('version');
const bump = arg('bump') || 'minor';

// The registry, not `npm view` — npm's CLI serves stale cached metadata for
// minutes after a publish, which would hand back a version number that is
// already taken.
const response = await fetch(REGISTRY, {
  headers: { accept: 'application/vnd.npm.install-v1+json' },
});
if (!response.ok) {
  fail(`registry returned ${response.status} ${response.statusText} for ${PACKAGE}`);
}
const packument = await response.json();

const latestRaw = packument['dist-tags']?.latest;
if (!latestRaw) fail(`${PACKAGE} has no "latest" dist-tag`);
const latest = parse(latestRaw);
if (!latest) fail(`could not parse the published latest version "${latestRaw}"`);
if (latest.beta !== null) {
  fail(`the "latest" dist-tag points at a prerelease (${latestRaw}); fix that before cutting a beta`);
}

const published = new Set(Object.keys(packument.versions ?? {}));

let version;
if (requested) {
  const parsed = parse(requested);
  if (!parsed) fail(`"${requested}" is not a valid X.Y.Z-beta.N version`);
  if (parsed.beta === null) fail(`"${requested}" is not a beta version`);
  if (compare(parsed, latest) <= 0) {
    fail(`"${requested}" is not above the published latest (${latestRaw}); @beta must never be older than @latest`);
  }
  version = requested;
} else {
  const base = bumpBase(latest, bump);
  const baseParsed = parse(base);
  let highest = 0;
  for (const candidate of published) {
    const parsed = parse(candidate);
    if (!parsed || parsed.beta === null) continue;
    if (compare({ ...parsed, beta: null }, baseParsed) !== 0) continue;
    if (parsed.beta > highest) highest = parsed.beta;
  }
  version = `${base}-beta.${highest + 1}`;
}

if (published.has(version)) {
  fail(`${version} is already published — npm versions can never be reused`);
}

console.log(version);
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
