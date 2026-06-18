#!/usr/bin/env node
/**
 * Cross-compile the CLI to single-file binaries for all published platforms
 * using `bun build --compile`. Writes outputs to dist-bin/ and a SHA256SUMS
 * manifest used by `dcd upgrade` to verify downloads.
 *
 * Run locally: pnpm build:binaries  (or: node scripts/build-binaries.mjs)
 * Run in CI:   .github/workflows/release-binaries.yml
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repoRoot, 'dist-bin');

// Each entry maps a Bun cross-compile target to the GitHub Release asset name.
// outName excludes `.exe` because Bun appends it automatically for windows targets.
const targets = [
  { target: 'bun-darwin-arm64', outName: 'dcd-darwin-arm64', asset: 'dcd-darwin-arm64' },
  { target: 'bun-darwin-x64', outName: 'dcd-darwin-x64', asset: 'dcd-darwin-x64' },
  { target: 'bun-linux-arm64', outName: 'dcd-linux-arm64', asset: 'dcd-linux-arm64' },
  { target: 'bun-linux-x64', outName: 'dcd-linux-x64', asset: 'dcd-linux-x64' },
  { target: 'bun-windows-x64', outName: 'dcd-windows-x64', asset: 'dcd-windows-x64.exe' },
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const { target, outName, asset } of targets) {
  const out = join(outDir, outName);
  console.log(`→ ${target}`);
  execFileSync(
    'bun',
    ['build', '--compile', `--target=${target}`, 'src/index.ts', '--outfile', out],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  const produced = join(outDir, asset);
  if (!existsSync(produced)) {
    throw new Error(`Bun did not produce expected output: ${produced}`);
  }
}

const lines = readdirSync(outDir)
  .filter((f) => f !== 'SHA256SUMS')
  .sort()
  .map((file) => {
    const hex = createHash('sha256').update(readFileSync(join(outDir, file))).digest('hex');
    return `${hex}  ${file}`;
  });

const sumsPath = join(outDir, 'SHA256SUMS');
writeFileSync(sumsPath, lines.join('\n') + '\n');

console.log('\nSHA256SUMS:');
console.log(lines.join('\n'));
