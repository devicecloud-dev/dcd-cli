#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// mock-api lives in the sibling dcd/ repo while the oclif→citty migration settles.
// Override with MOCK_API_DIR=/path/to/mock-api if it moves.
const mockApiDir =
  process.env.MOCK_API_DIR ??
  path.resolve(__dirname, '../../dcd/mock-api');
const cliDir = path.resolve(__dirname, '..');

let mockApiProcess;

function cleanup() {
  if (mockApiProcess && !mockApiProcess.killed) {
    console.log('Stopping mock API...');
    mockApiProcess.kill('SIGTERM');
  }
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

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
      shell: true
    });

    // Wait for mock API to start
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Run tests
    console.log('Running tests...');
    const testProcess = spawn('npx', [
      'mocha',
      '--no-warnings',
      '--require', 'ts-node/register',
      'test/**/*.test.ts',
      '--timeout', '60000'
    ], {
      cwd: cliDir,
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        TS_NODE_COMPILER_OPTIONS: JSON.stringify({
          module: 'commonjs',
          target: 'es2022'
        })
      }
    });

    testProcess.on('close', (code) => {
      cleanup();
      process.exit(code);
    });

  } catch (error) {
    console.error('Test runner error:', error);
    cleanup();
    process.exit(1);
  }
}

runTests().catch(console.error);