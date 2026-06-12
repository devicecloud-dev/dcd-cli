#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// mock-api lives in the sibling dcd/ repo while the oclif→citty migration settles.
// Override with MOCK_API_DIR=/path/to/mock-api if it moves.
const mockApiDir =
  process.env.MOCK_API_DIR ??
  path.resolve(__dirname, '../../dcd/mock-api');
const cliDir = path.resolve(__dirname, '..');

const MOCK_API_URL = 'http://localhost:3001/';
const READY_DEADLINE_MS = 30_000;
const READY_POLL_INTERVAL_MS = 500;

let mockApiProcess;
let mockApiExited = false;
let testsFinished = false;

// Isolated config dir so the CLI under test can never read (or refresh —
// Supabase rotates refresh tokens) the developer's real ~/.config/dcd session.
const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-test-config-'));

function killMockApi() {
  if (!mockApiProcess || mockApiExited) return;
  console.log('Stopping mock API...');
  // The mock API is spawned via `npm run` with `shell: true`, so signalling
  // only the wrapper can orphan the actual server and leave port 3001 bound.
  // On POSIX we spawned it detached (its own process group) and signal the
  // whole group; Windows has no process groups, so fall back to kill().
  if (process.platform === 'win32') {
    if (!mockApiProcess.killed) mockApiProcess.kill('SIGTERM');
  } else {
    try {
      process.kill(-mockApiProcess.pid, 'SIGTERM');
    } catch {
      // Process group already gone — nothing to clean up.
    }
  }
}

function cleanup() {
  killMockApi();
  fs.rmSync(testConfigDir, { recursive: true, force: true });
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

// Forward a child stream line-by-line with a prefix so mock API boot
// failures are visible and the pipe buffer never fills up unread.
function forwardOutput(stream, write) {
  if (!stream) return;
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines) write(`[mock-api] ${line}\n`);
  });
  stream.on('end', () => {
    if (buffered) write(`[mock-api] ${buffered}\n`);
  });
}

// Poll until the mock API accepts connections. Any HTTP response (even a
// 404) counts as "listening"; only connection errors count as not-ready.
async function waitForMockApi() {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (mockApiExited) {
      throw new Error('Mock API exited before becoming ready');
    }
    try {
      await fetch(MOCK_API_URL);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    }
  }
  killMockApi();
  throw new Error(
    `Mock API did not become ready at ${MOCK_API_URL} within ${READY_DEADLINE_MS / 1000}s`
  );
}

async function runTests() {
  try {
    // Build CLI first for faster test execution
    console.log('Building CLI...');
    const buildProcess = spawn('pnpm', ['build'], {
      cwd: cliDir,
      stdio: 'inherit',
      shell: true
    });

    await new Promise((resolve, reject) => {
      buildProcess.on('close', (code) => {
        if (code === 0) {
          resolve(code);
        } else {
          reject(new Error(`Build failed with code ${code}`));
        }
      });
    });

    // Start mock API with authentication
    console.log('Starting mock API with authentication...');
    mockApiProcess = spawn('npm', ['run', 'start:auth'], {
      cwd: mockApiDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      // Own process group on POSIX so killMockApi() can signal `npm run`
      // *and* the server it spawns, not just the wrapper.
      detached: process.platform !== 'win32',
    });

    forwardOutput(mockApiProcess.stdout, (text) => process.stdout.write(text));
    forwardOutput(mockApiProcess.stderr, (text) => process.stderr.write(text));

    mockApiProcess.on('error', (error) => {
      console.error('Mock API failed to start:', error);
      if (!testsFinished) {
        process.exit(1);
      }
    });

    mockApiProcess.on('exit', (code, signal) => {
      mockApiExited = true;
      if (!testsFinished) {
        console.error(
          `Mock API exited before tests finished (code ${code}, signal ${signal})`
        );
        process.exit(1);
      }
    });

    console.log('Waiting for mock API to be ready...');
    await waitForMockApi();
    console.log('Mock API is ready.');

    // Run tests. Mocha + .mocharc.json handle TypeScript loading via `tsx`
    // (see `node-option: ["import=tsx"]` there). Mocha 11 imports files as
    // ESM, so the `require: ts-node/register` hook doesn't get applied; tsx
    // registers an ESM loader that resolves TS relative imports correctly.
    console.log('Running tests...');
    const testProcess = spawn('npx', [
      'mocha',
      '--no-warnings',
      'test/**/*.test.ts',
      '--timeout', '60000'
    ], {
      cwd: cliDir,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, DCD_CONFIG_DIR: testConfigDir },
    });

    testProcess.on('close', (code) => {
      testsFinished = true;
      cleanup();
      // `code` is null when mocha is killed by a signal — treat as failure.
      process.exit(code ?? 1);
    });

  } catch (error) {
    console.error('Test runner error:', error);
    cleanup();
    process.exit(1);
  }
}

runTests().catch(console.error);
